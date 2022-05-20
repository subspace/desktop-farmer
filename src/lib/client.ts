import { ApiPromise, Keyring } from "@polkadot/api"
import type { Vec } from "@polkadot/types/codec"
import type { u128 } from "@polkadot/types"
import { mnemonicGenerate, cryptoWaitReady } from "@polkadot/util-crypto"
import * as event from "@tauri-apps/api/event"
import { invoke } from "@tauri-apps/api/tauri"
import { reactive } from "vue"
import * as process from "process"
import * as util from "../lib/util"
import { appConfig } from "./appConfig"
import { getStoredBlocks, storeBlocks } from "./blockStorage"
import {
  emptyClientData,
  NetStatus,
  FarmedBlock,
  SubPreDigest
} from "../lib/types"
import type { SyncState } from '@polkadot/types/interfaces/system';

const tauri = { event, invoke }
const SUNIT = 1000000000000000000n

const NETWORK_RPC = process.env.PUBLIC_API_WS || "ws://localhost:9944";
const appsLink = "https://polkadot.js.org/apps/?rpc=" + NETWORK_RPC + "#/explorer/query/"

export class Client {
  protected firstLoad = false
  protected mnemonic = ""
  protected farmed: FarmedBlock[] = []
  protected clearTauriDestroy: event.UnlistenFn = () => null;
  protected unsubscribe: event.UnlistenFn = () => null;

  private api: ApiPromise;

  constructor (api: ApiPromise) {
    this.api = api;
  }

  data = reactive(emptyClientData)
  status = {
    net: async (): Promise<NetStatus> => {
      const peers = await this.api.rpc.system.peers()
      return { peers }
    }
  }
  do = {
    blockSubscription: {
      stopOnReload(): void {
        this.stop()
      },
      start: async (): Promise<void> => {

        const rewardAddress: string = (await appConfig.read()).rewardAddress
        if (rewardAddress === "") {
          util.errorLogger("Reward address should not have been empty...")
          return
        }

        this.unsubscribe = await this.api.rpc.chain.subscribeNewHeads(
          async ({ hash, number }) => {
            const blockNum = number.toNumber()
            const signedBlock = await this.api.rpc.chain.getBlock(hash)
            const preRuntime: SubPreDigest = this.api.registry.createType(
              'SubPreDigest',
              signedBlock.block.header.digest.logs.find((digestItem) => digestItem.isPreRuntime)
                ?.asPreRuntime![1]);

            if (preRuntime.solution.reward_address.toString() === rewardAddress) {
              console.log("Farmed by me:", blockNum)
              let blockReward = 0
              const allRecords: Vec<any> =
                await this.api.query.system.events.at(hash)
              allRecords.forEach((record) => {
                const { section, method, data } = record.event
                if (section === "rewards" && method === "BlockReward") {
                  const reward: u128 = this.api.registry.createType(
                    "u128",
                    data[1]
                  )
                  blockReward = Number((reward.toBigInt() * 100n) / SUNIT) / 100
                } else if (section === "transactionFees") {
                  // TODO
                }
              })

              const block: FarmedBlock = {
                id: hash.toString(),
                time: Date.now(),
                transactions: 0,
                blockNum,
                blockReward,
                feeReward: 0,
                rewardAddr: rewardAddress.toString(),
                appsLink: appsLink + blockNum.toString()
              }
              this.data.farming.farmed = [block].concat(
                this.data.farming.farmed
              )
              storeBlocks(this.data.farming.farmed)
              this.data.farming.events.emit("farmedBlock", block)

            }
            this.data.farming.events.emit("newBlock", blockNum)
          }
        )
        process.on("beforeExit", this.do.blockSubscription.stopOnReload)
        window.addEventListener(
          "unload",
          this.do.blockSubscription.stopOnReload
        )
        this.clearTauriDestroy = await tauri.event.once(
          "tauri://destroyed",
          () => {
            console.log("Destroyed event!")
            storeBlocks(this.data.farming.farmed)
          }
        )
      },
      stop: (): void => {
        util.infoLogger("block subscription stop triggered")
        this.unsubscribe()
        this.api.disconnect()
        try {
          this.clearTauriDestroy()
          storeBlocks(this.data.farming.farmed)
          window.removeEventListener(
            "unload",
            this.do.blockSubscription.stopOnReload
          )
        } catch (error) {
          util.errorLogger(error)
        }
      }
    }
  }

  public async startBlockSubscription(): Promise<void> {
    await this.do.blockSubscription.start()
  }

  /* To be called ONLY from plotting progress */
  public setFirstLoad(): void {
    this.firstLoad = true
  }
  /* To be called from dashboard, if isFirstLoad dashboard will not start NODE or FARMER as plottingProgress page already done this and also started block subscriptions. */
  public isFirstLoad(): boolean {
    return this.firstLoad
  }

  public async connectApi(): Promise<void> {
    if (!this.api.isConnected) {
      await this.api.connect()
    }
    await this.api.isReady
  }

  public async getSyncState():Promise<SyncState> {
    return this.api.rpc.system.syncState();
  }

  public async startNode(path: string, nodeName: string): Promise<void> {
    await tauri.invoke("start_node", { path, nodeName })
    if (!this.firstLoad) {
      this.loadStoredBlocks()
    }
    // TODO: workaround in case node takes some time to fully start.
    await new Promise((resolve) => setTimeout(resolve, 7000))
    await this.connectApi()
  }

  private loadStoredBlocks(): void {
    this.farmed = getStoredBlocks()
    this.data.farming.farmed = this.farmed
  }

  public async createRewardAddress(): Promise<string> {
    try {
      const mnemonic = mnemonicGenerate()
      const keyring = new Keyring({ type: 'sr25519', ss58Format: 2254 }) // 2254 is the prefix for subspace-testnet
      await cryptoWaitReady();
      const pair = keyring.createFromUri(mnemonic)
      this.mnemonic = mnemonic
      return pair.address
    } catch (error) {
      util.errorLogger(error)
      return ""
    }
  }

  /* FARMER INTEGRATION */
  public async startFarming(path: string, plotSizeGB: number): Promise<boolean> {
    const plotSize = Math.round(plotSizeGB * 1048576)
    const rewardAddress: string = (await appConfig.read()).rewardAddress
    if (rewardAddress === "") {
      util.errorLogger("Tried to send empty reward address to backend!")
    }
    return await tauri.invoke("farming", { path, rewardAddress, plotSize })
  }

  /* MNEMONIC displayed only FIRST LOAD on SaveKeys Modal. */
  public getMnemonic(): string {
    return this.mnemonic
  }
  public clearMnemonic(): void {
    this.mnemonic = ""
  }
}
