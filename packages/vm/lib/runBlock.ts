import { encode } from 'rlp'
import { BaseTrie as Trie } from 'merkle-patricia-tree'
import { Account, Address, BN, intToBuffer } from 'ethereumjs-util'
import { Block } from '@ethereumjs/block'
import VM from './index'
import Bloom from './bloom'
import { StateManager } from './state'
import { short } from './evm/opcodes'
import type { TypedTransaction } from '@ethereumjs/tx'
import type { RunTxResult } from './runTx'
import type { TxReceipt } from './types'
import * as DAOConfig from './config/dao_fork_accounts_config.json'

// For backwards compatibility from v5.3.0,
// TxReceipts are exported. These exports are
// deprecated and may be removed soon, please
// update your imports to the new types file.
import { PreByzantiumTxReceipt, PostByzantiumTxReceipt, EIP2930Receipt } from './types'
export { PreByzantiumTxReceipt, PostByzantiumTxReceipt, EIP2930Receipt }

/* DAO account list */
const DAOAccountList = DAOConfig.DAOAccounts
const DAORefundContract = DAOConfig.DAORefundContract

/**
 * Options for running a block.
 */
export interface RunBlockOpts {
  /**
   * The @ethereumjs/block to process
   */
  block: Block
  /**
   * Root of the state trie
   */
  root?: Buffer
  /**
   * Whether to generate the stateRoot and other related fields.
   * If `true`, `runBlock` will set the fields `stateRoot`, `receiptsTrie`, `gasUsed`, and `bloom` (logs bloom) after running the block.
   * If `false`, `runBlock` throws if any fields do not match.
   * Defaults to `false`.
   */
  generate?: boolean
  /**
   * If true, will skip "Block validation":
   * Block validation validates the header (with respect to the blockchain),
   * the transactions, the transaction trie and the uncle hash.
   */
  skipBlockValidation?: boolean
  /**
   * If true, skips the nonce check
   */
  skipNonce?: boolean
  /**
   * If true, skips the balance check
   */
  skipBalance?: boolean
}

/**
 * Result of [[runBlock]]
 */
export interface RunBlockResult {
  /**
   * Receipts generated for transactions in the block
   */
  receipts: TxReceipt[]
  /**
   * Results of executing the transactions in the block
   */
  results: RunTxResult[]
  /**
   * The stateRoot after executing the block
   */
  stateRoot: Buffer
  /**
   * The gas used after executing the block
   */
  gasUsed: BN
  /**
   * The bloom filter of the LOGs (events) after executing the block
   */
  logsBloom: Buffer
  /**
   * The receipt root after executing the block
   */
  receiptRoot: Buffer
}

export interface AfterBlockEvent extends RunBlockResult {
  // The block which just finished processing
  block: Block
}

/**
 * @ignore
 */
export default async function runBlock(this: VM, opts: RunBlockOpts): Promise<RunBlockResult> {
  const state = this.stateManager
  const { root } = opts
  let { block } = opts
  const generateFields = !!opts.generate

  /**
   * The `beforeBlock` event.
   *
   * @event Event: beforeBlock
   * @type {Object}
   * @property {Block} block emits the block that is about to be processed
   */
  await this._emit('beforeBlock', block)

  if (this._hardforkByBlockNumber) {
    this._common.setHardforkByBlockNumber(block.header.number.toNumber())
  }


  // Set state root if provided
  if (root) {
    await state.setStateRoot(root)
  }

  // check for DAO support and if we should apply the DAO fork
  if (
    this._common.hardforkIsActiveOnChain('dao') &&
    block.header.number.eq(this._common.hardforkBlockBN('dao'))
  ) {
    await _applyDAOHardfork(state)
  }

  // Checkpoint state
  await state.checkpoint()

  let result
  try {
    result = await applyBlock.bind(this)(block, opts)

  } catch (err) {
    await state.revert()

    throw err
  }

  // Persist state
  await state.commit()


  const stateRoot = await state.getStateRoot(false)

  // Given the generate option, either set resulting header
  // values to the current block, or validate the resulting
  // header values against the current block.
  if (generateFields) {
    const bloom = result.bloom.bitvector
    const gasUsed = result.gasUsed
    const receiptTrie = result.receiptRoot
    const transactionsTrie = await _genTxTrie(block)
    const generatedFields = { stateRoot, bloom, gasUsed, receiptTrie, transactionsTrie }
    const blockData = {
      ...block,
      header: { ...block.header, ...generatedFields },
    }
    block = Block.fromBlockData(blockData, { common: this._common })
  } else {
    if (result.receiptRoot && !result.receiptRoot.equals(block.header.receiptTrie)) {

      throw new Error('invalid receiptTrie')
    }
    if (!result.bloom.bitvector.equals(block.header.bloom)) {

      throw new Error('invalid bloom')
    }
    if (!result.gasUsed.eq(block.header.gasUsed)) {
      throw new Error('invalid gasUsed')
    }
    if (!stateRoot.equals(block.header.stateRoot)) {
      throw new Error('invalid block stateRoot')
    }
  }

  const results: RunBlockResult = {
    receipts: result.receipts,
    results: result.results,
    stateRoot,
    gasUsed: result.gasUsed,
    logsBloom: result.bloom.bitvector,
    receiptRoot: result.receiptRoot,
  }

  const afterBlockEvent: AfterBlockEvent = { ...results, block }

  /**
   * The `afterBlock` event
   *
   * @event Event: afterBlock
   * @type {AfterBlockEvent}
   * @property {AfterBlockEvent} result emits the results of processing a block
   */
  await this._emit('afterBlock', afterBlockEvent)


  return results
}

/**
 * Validates and applies a block, computing the results of
 * applying its transactions. This method doesn't modify the
 * block itself. It computes the block rewards and puts
 * them on state (but doesn't persist the changes).
 * @param {Block} block
 * @param {RunBlockOpts} opts
 */
async function applyBlock(this: VM, block: Block, opts: RunBlockOpts) {
  // Validate block
  if (!opts.skipBlockValidation) {
    if (block.header.gasLimit.gte(new BN('8000000000000000', 16))) {
      throw new Error('Invalid block with gas limit greater than (2^63 - 1)')
    } else {
      await block.validate(this.blockchain)
    }
  }
  // Apply transactions
  const blockResults = await applyTransactions.bind(this)(block, opts)
  // Pay ommers and miners
  if (this._common.consensusType() === 'pow') {
    await assignBlockRewards.bind(this)(block)
  }
  return blockResults
}

/**
 * Applies the transactions in a block, computing the receipts
 * as well as gas usage and some relevant data. This method is
 * side-effect free (it doesn't modify the block nor the state).
 * @param {Block} block
 * @param {RunBlockOpts} opts
 */
async function applyTransactions(this: VM, block: Block, opts: RunBlockOpts) {
  const bloom = new Bloom()
  // the total amount of gas used processing these transactions
  let gasUsed = new BN(0)
  const receiptTrie = new Trie()
  const receipts = []
  const txResults = []

  /*
   * Process transactions
   */
  for (let txIdx = 0; txIdx < block.transactions.length; txIdx++) {
    const tx = block.transactions[txIdx]

    const gasLimitIsHigherThanBlock = block.header.gasLimit.lt(tx.gasLimit.add(gasUsed))
    if (gasLimitIsHigherThanBlock) {
      throw new Error('tx has a higher gas limit than the block')
    }

    // Run the tx through the VM
    const { skipBalance, skipNonce } = opts

    // Construct a block with the current gasUsed for accurate tx receipt generation
    const blockWithGasUsed = Block.fromBlockData(
      { ...block, header: { ...block.header, gasUsed } },
      { common: this._common }
    )

    const txRes = await this.runTx({
      tx,
      block: blockWithGasUsed,
      skipBalance,
      skipNonce,
    })
    txResults.push(txRes)

    // Add to total block gas usage
    gasUsed = gasUsed.add(txRes.gasUsed)

    // Combine blooms via bitwise OR
    bloom.or(txRes.bloom)

    // Add receipt to trie to later calculate receipt root
    receipts.push(txRes.receipt)
    const encodedReceipt = encodeReceipt(tx, txRes.receipt)
    await receiptTrie.put(encode(txIdx), encodedReceipt)
  }

  return {
    bloom,
    gasUsed,
    receiptRoot: receiptTrie.root,
    receipts,
    results: txResults,
  }
}

/**
 * Calculates block rewards for miner and ommers and puts
 * the updated balances of their accounts to state.
 */
async function assignBlockRewards(this: VM, block: Block): Promise<void> {

  const state = this.stateManager
  const minerReward = new BN(this._common.param('pow', 'minerReward'))
  const ommers = block.uncleHeaders
  // Reward ommers
  for (const ommer of ommers) {
    const reward = calculateOmmerReward(ommer.number, block.header.number, minerReward)
    const account = await rewardAccount(state, ommer.coinbase, reward)

  }
  // Reward miner
  const reward = calculateMinerReward(minerReward, ommers.length)
  const account = await rewardAccount(state, block.header.coinbase, reward)

}

function calculateOmmerReward(ommerBlockNumber: BN, blockNumber: BN, minerReward: BN): BN {
  const heightDiff = blockNumber.sub(ommerBlockNumber)
  let reward = new BN(8).sub(heightDiff).mul(minerReward.divn(8))
  if (reward.ltn(0)) {
    reward = new BN(0)
  }
  return reward
}

export function calculateMinerReward(minerReward: BN, ommersNum: number): BN {
  // calculate nibling reward
  const niblingReward = minerReward.divn(32)
  const totalNiblingReward = niblingReward.muln(ommersNum)
  const reward = minerReward.add(totalNiblingReward)
  return reward
}

export async function rewardAccount(
  state: StateManager,
  address: Address,
  reward: BN
): Promise<Account> {
  const account = await state.getAccount(address)
  account.balance.iadd(reward)
  await state.putAccount(address, account)
  return account
}

/**
 * Returns the encoded tx receipt.
 */
export function encodeReceipt(tx: TypedTransaction, receipt: TxReceipt) {
  const encoded = encode(Object.values(receipt))

  if (!('transactionType' in tx) || tx.transactionType === 0) {
    return encoded
  }

  const type = intToBuffer(tx.transactionType)
  return Buffer.concat([type, encoded])
}

/**
 * Generates the tx receipt and returns { txReceipt, encodedReceipt, receiptLog }
 * @deprecated Please use the new `generateTxReceipt` located in runTx.
 */
export async function generateTxReceipt(
  this: VM,
  tx: TypedTransaction,
  txRes: RunTxResult,
  blockGasUsed: BN
) {
  const abstractTxReceipt = {
    gasUsed: blockGasUsed.toArrayLike(Buffer),
    bitvector: txRes.bloom.bitvector,
    logs: txRes.execResult.logs || [],
  }

  let txReceipt
  let encodedReceipt

  let receiptLog = `Generate tx receipt transactionType=${
    'transactionType' in tx ? tx.transactionType : 'NaN'
  } gasUsed=${blockGasUsed.toString()} bitvector=${short(abstractTxReceipt.bitvector)} (${
    abstractTxReceipt.bitvector.length
  } bytes) logs=${abstractTxReceipt.logs.length}`

  if (!('transactionType' in tx) || tx.transactionType === 0) {
    // Legacy transaction
    if (this._common.gteHardfork('byzantium')) {
      // Post-Byzantium
      txReceipt = {
        status: txRes.execResult.exceptionError ? 0 : 1, // Receipts have a 0 as status on error
        ...abstractTxReceipt,
      } as PostByzantiumTxReceipt
      const statusInfo = txRes.execResult.exceptionError ? 'error' : 'ok'
      receiptLog += ` status=${txReceipt.status} (${statusInfo}) (>= Byzantium)`
    } else {
      // Pre-Byzantium
      const stateRoot = await this.stateManager.getStateRoot(true)
      txReceipt = {
        stateRoot: stateRoot,
        ...abstractTxReceipt,
      } as PreByzantiumTxReceipt
      receiptLog += ` stateRoot=${txReceipt.stateRoot.toString('hex')} (< Byzantium)`
    }
    encodedReceipt = encode(Object.values(txReceipt))
  } else if ('transactionType' in tx && tx.transactionType === 1) {
    // EIP2930 Transaction
    txReceipt = {
      status: txRes.execResult.exceptionError ? 0 : 1,
      ...abstractTxReceipt,
    } as EIP2930Receipt
    encodedReceipt = Buffer.concat([Buffer.from('01', 'hex'), encode(Object.values(txReceipt))])
  } else {
    throw new Error(
      `Unsupported transaction type ${'transactionType' in tx ? tx.transactionType : 'NaN'}`
    )
  }
  return {
    txReceipt,
    encodedReceipt,
    receiptLog,
  }
}

// apply the DAO fork changes to the VM
async function _applyDAOHardfork(state: StateManager) {
  const DAORefundContractAddress = new Address(Buffer.from(DAORefundContract, 'hex'))
  if (!state.accountExists(DAORefundContractAddress)) {
    await state.putAccount(DAORefundContractAddress, new Account())
  }
  const DAORefundAccount = await state.getAccount(DAORefundContractAddress)

  for (const addr of DAOAccountList) {
    // retrieve the account and add it to the DAO's Refund accounts' balance.
    const address = new Address(Buffer.from(addr, 'hex'))
    const account = await state.getAccount(address)
    DAORefundAccount.balance.iadd(account.balance)
    // clear the accounts' balance
    account.balance = new BN(0)
    await state.putAccount(address, account)
  }

  // finally, put the Refund Account
  await state.putAccount(DAORefundContractAddress, DAORefundAccount)
}

async function _genTxTrie(block: Block) {
  const trie = new Trie()
  for (const [i, tx] of block.transactions.entries()) {
    await trie.put(encode(i), tx.serialize())
  }
  return trie.root
}
