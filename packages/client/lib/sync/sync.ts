import { BN } from 'ethereumjs-util'
import { PeerPool } from '../net/peerpool'
import { Peer } from '../net/peer/peer'
import { FlowControl } from '../net/protocol'
import { Config } from '../config'
import { Chain } from '../blockchain'
import { Event } from '../types'
// eslint-disable-next-line implicit-dependencies/no-implicit
import type { LevelUp } from 'levelup'
import { BlockFetcher, HeaderFetcher } from './fetcher'
import { short } from '../util'

export interface SynchronizerOptions {
  /* Config */
  config: Config

  /* Peer pool */
  pool: PeerPool

  /* Blockchain */
  chain: Chain

  /* State database */
  stateDB?: LevelUp

  /* Flow control manager */
  flow?: FlowControl

  /* Refresh interval in ms (default: 1000) */
  interval?: number
}

/**
 * Base class for blockchain synchronizers
 * @memberof module:sync
 */
export abstract class Synchronizer {
  public config: Config

  protected pool: PeerPool
  protected chain: Chain
  protected fetcher: BlockFetcher | HeaderFetcher | null
  protected flow: FlowControl
  protected interval: number
  public opened: boolean
  public running: boolean
  protected forceSync: boolean
  public startingBlock: BN

  // Best known sync block height
  public syncTargetHeight?: BN
  // Time (in ms) after which the synced state is reset
  private SYNCED_STATE_REMOVAL_PERIOD = 60000
  /* global NodeJS */
  private _syncedStatusCheckInterval: NodeJS.Timeout | undefined

  /**
   * Create new node
   * @param {SynchronizerOptions}
   */
  constructor(options: SynchronizerOptions) {
    this.config = options.config

    this.pool = options.pool
    this.chain = options.chain
    this.fetcher = null
    this.flow = options.flow ?? new FlowControl()
    this.interval = options.interval ?? 1000
    this.opened = false
    this.running = false
    this.forceSync = false
    this.startingBlock = new BN(0)

    this.config.events.on(Event.POOL_PEER_ADDED, (peer) => {
      if (this.syncable(peer)) {
        this.config.logger.debug(`Found ${this.type} peer: ${peer}`)
      }
    })

    this.config.events.on(Event.CHAIN_UPDATED, async () => {
      this.updateSynchronizedState()
    })
  }

  /**
   * Returns synchronizer type
   */
  get type(): string {
    return 'sync'
  }

  /**
   * Open synchronizer. Must be called before sync() is called
   * @return {Promise}
   */
  async open() {
    this.opened = true
  }

  /**
   * Returns true if peer can be used for syncing
   * @return {boolean}
   */
  // TODO: evaluate syncability of peer
  syncable(_peer: Peer): boolean {
    return true
  }

  /**
   * Start synchronization
   */
  async start(): Promise<void | boolean> {
    if (this.running) {
      return false
    }
    this.running = true

    this._syncedStatusCheckInterval = setInterval(
      this._syncedStatusCheck.bind(this),
      this.SYNCED_STATE_REMOVAL_PERIOD
    )

    const timeout = setTimeout(() => {
      this.forceSync = true
    }, this.interval * 30)
    while (this.running) {
      try {
        await this.sync()
      } catch (error: any) {
        this.config.events.emit(Event.SYNC_ERROR, error)
      }
      await new Promise((resolve) => setTimeout(resolve, this.interval))
    }
    this.running = false
    clearTimeout(timeout)
  }

  abstract best(): Peer | undefined

  abstract syncWithPeer(peer?: Peer): Promise<boolean>

  /**
   * Checks if the synchronized state of the chain has changed
   *
   * @emits Event.SYNC_SYNCHRONIZED
   */
  updateSynchronizedState() {
    if (!this.syncTargetHeight) {
      return
    }
    if (this.chain.headers.height.gte(this.syncTargetHeight)) {
      if (!this.config.synchronized) {
        const hash = this.chain.headers.latest?.hash()
        this.config.logger.info(
          `Chain synchronized height=${this.chain.headers.height} number=${short(hash!)}`
        )
      }
      this.config.synchronized = true
      this.config.lastSyncDate = Date.now()

      this.config.events.emit(Event.SYNC_SYNCHRONIZED, this.chain.headers.height)
    }
  }

  /**
   * Fetch all blocks from current height up to highest found amongst peers
   * @return Resolves with true if sync successful
   */
  async sync(): Promise<boolean> {
    let peer = this.best()
    let numAttempts = 1
    while (!peer && this.opened) {
      this.config.logger.debug(`Waiting for best peer (attempt #${numAttempts})`)
      await new Promise((resolve) => setTimeout(resolve, 5000))
      peer = this.best()
      numAttempts += 1
    }
    return this.syncWithPeer(peer)
  }

  async stop(): Promise<boolean> {
    if (!this.running) {
      return false
    }
    clearInterval(this._syncedStatusCheckInterval as NodeJS.Timeout)
    await new Promise((resolve) => setTimeout(resolve, this.interval))
    this.running = false
    this.config.logger.info('Stopped synchronization.')
    return true
  }

  /**
   * Close synchronizer.
   * @return {Promise}
   */
  async close() {
    this.opened = false
  }

  /**
   * Reset synced status after a certain time with no
   * chain updates
   */
  _syncedStatusCheck() {
    if (this.config.synchronized) {
      const diff = Date.now() - this.config.lastSyncDate
      if (diff >= this.SYNCED_STATE_REMOVAL_PERIOD) {
        this.config.synchronized = false
        this.config.logger.info(`Sync status reset (no chain updates for ${diff} seconds).`)
      }
    }
  }
}
