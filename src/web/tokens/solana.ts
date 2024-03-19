import type { Signer } from "arbundles";
import { HexInjectedSolanaSigner } from "arbundles/web";
import BigNumber from "bignumber.js";
import type { TokenConfig, Tx } from "../../common/types";
import BaseWebToken from "../token";
import bs58 from "bs58";
// @ts-expect-error only importing as type
import type { BaseSignerWalletAdapter } from "@solana/wallet-adapter-base";
import retry from "async-retry";
import type { Finality } from "@solana/web3.js";
import { Connection, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

const sleep = async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default class SolanaConfig extends BaseWebToken {
  private signer!: HexInjectedSolanaSigner;
  protected declare wallet: BaseSignerWalletAdapter;
  minConfirm = 1;
  protected finality: Finality = "finalized";

  constructor(config: TokenConfig) {
    super(config);
    this.base = ["lamports", 1e9];
    this.finality = this?.opts?.finality ?? "finalized";
  }

  private async getProvider(): Promise<Connection> {
    if (!this.providerInstance) {
      this.providerInstance = new Connection(this.providerUrl, {
        confirmTransactionInitialTimeout: 60_000,
        commitment: this.finality,
      });
    }
    return this.providerInstance;
  }

  async getTx(txId: string): Promise<Tx> {
    const connection = await this.getProvider();
    const stx = await connection.getTransaction(txId, { commitment: this.finality, maxSupportedTransactionVersion: 0 });
    if (!stx) throw new Error("Confirmed tx not found");

    const currentSlot = await connection.getSlot(this.finality);
    if (!stx.meta) throw new Error(`Unable to resolve transaction ${txId}`);

    const amount = new BigNumber(stx.meta.postBalances[1]).minus(new BigNumber(stx.meta.preBalances[1]));

    const staticAccountKeys = stx.transaction.message.getAccountKeys().staticAccountKeys;
    const tx: Tx = {
      from: staticAccountKeys[0].toBase58(),
      to: staticAccountKeys[1].toBase58(),
      amount: amount,
      blockHeight: new BigNumber(stx.slot),
      pending: false,
      confirmed: currentSlot - stx.slot >= 1,
    };
    return tx;
  }

  ownerToAddress(owner: any): string {
    if (typeof owner === "string") {
      owner = Buffer.from(owner);
    }
    return bs58.encode(owner);
  }

  async sign(data: Uint8Array): Promise<Uint8Array> {
    return await (await this.getSigner()).sign(data);
  }

  getSigner(): Signer {
    if (!this.signer) {
      // if (this.wallet?.name === "Phantom") {
      //     this.signer = new PhantomSigner(this.wallet)
      // } else {
      //     this.signer = new InjectedSolanaSigner(this.wallet)
      // }
      this.signer = new HexInjectedSolanaSigner(this.wallet);
    }
    return this.signer;
  }

  verify(pub: any, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
    // if (this.wallet?.name === "Phantom") {
    //     return PhantomSigner.verify(pub, data, signature)
    // }
    // return InjectedSolanaSigner.verify(pub, data, signature);
    return HexInjectedSolanaSigner.verify(pub, data, signature);
  }

  async getCurrentHeight(): Promise<BigNumber> {
    return new BigNumber((await (await this.getProvider()).getEpochInfo()).blockHeight ?? 0);
  }

  async getFee(_amount: BigNumber.Value, _to?: string): Promise<BigNumber> {
    // const connection = await this.getProvider()
    // const block = await connection.getRecentBlockhash();
    // const feeCalc = await connection.getFeeCalculatorForBlockhash(
    //     block.blockhash,
    // );
    // return new BigNumber(feeCalc.value.lamportsPerSignature);
    return new BigNumber(5000); // hardcode it for now
  }

  async sendTx(data: any): Promise<string | undefined> {
    const connection = await this.getProvider();
    const signed: Transaction = await this.wallet.signTransaction(data);

    const blockhash = await connection.getLatestBlockhash();
    let blockheight = await connection.getBlockHeight("confirmed");
    const serialized = signed.serialize();
    const signature = await connection.sendRawTransaction(serialized);
    let resolved = false;
    const confPromise = connection.confirmTransaction({ signature, ...blockhash }, this.finality);

    while (blockheight < blockhash.lastValidBlockHeight && !resolved) {
      try {
        console.log("sending again");
        await connection.sendRawTransaction(serialized);
        await sleep(500);
      } catch (err: any) {
        if (err.message.includes("This transaction has already been processed")) {
          resolved = true;
        } else {
          console.log(err);
        }
      }
      blockheight = await connection.getBlockHeight();
    }

    const conf = await confPromise;

    if (conf.value.err) {
      throw new Error("Error confirming transaction");
    }

    return signature;
  }

  async createTx(amount: BigNumber.Value, to: string, _fee?: string): Promise<{ txId: string | undefined; tx: any }> {
    // TODO: figure out how to manually set fees
    const pubkey = new PublicKey(await this.getPublicKey());
    const blockHashInfo = await retry(
      async (bail) => {
        try {
          return await (await this.getProvider()).getLatestBlockhash(this.finality);
        } catch (e: any) {
          if (e.message?.includes("blockhash")) throw e;
          else bail(e);
          throw new Error("Unreachable");
        }
      },
      { retries: 3, minTimeout: 1000 },
    );
    // const transaction = new Transaction({ recentBlockhash: blockHashInfo.blockhash, feePayer: pubkey });
    const transaction = new Transaction({ ...blockHashInfo, feePayer: pubkey });
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: pubkey,
        toPubkey: new PublicKey(to),
        lamports: +new BigNumber(amount).toNumber(),
      }),
    );

    return { tx: transaction, txId: undefined };
  }

  async getPublicKey(): Promise<string | Buffer> {
    if (!this.wallet.publicKey) throw new Error("Wallet.publicKey is undefined");
    return this.wallet.publicKey.toBuffer();
  }
}
