#!/usr/bin/env node
// Note: DO NOT REMOVE/ALTER THE ABOVE LINE - it is called a 'shebang' and is vital for CLI execution.
import BigNumber from "bignumber.js";
import { Command } from "commander";
import { readFileSync } from "fs";
import inquirer from "inquirer";
import type NodeIrys from "./irys";
import Irys from "./irys";
import { checkPath } from "./upload";

export const program = new Command();

let balpad, walpad; // padding state variables

// Define the CLI flags for the program
program
  .option("-h, --host <string>", "Irys node hostname/URL (eg http://node1.irys.network)")
  .option("-w, --wallet <string>", "Path to keyfile or the private key itself", "default")
  .option("-c, --currency <string>", "The currency to use")
  .option("--timeout <number>", "The timeout (in ms) for API HTTP requests - increase if you get timeouts for upload")
  .option("--no-confirmation", "Disable confirmations for certain actions")
  .option(
    "--multiplier <number>",
    "Adjust the multiplier used for tx rewards - the higher the faster the network will process the transaction.",
    "1.00",
  )
  .option(
    "--batch-size <number>",
    "Adjust the upload-dir batch size (process more items at once - uses more resources (network, memory, cpu) accordingly!)",
    "5",
  )
  .option("--debug, -d", "Increases verbosity of errors and logs additional debug information. Used for troubleshooting.", false)
  .option("--index-file <string>", "Name of the file to use as an index for upload-dir manifests (relative to the path provided to upload-dir).")
  .option("--provider-url <string>", "Override the provider URL")
  .option("--contract-address <string>", "Override the contract address")
  .option("--content-type <string>", "Override the content type for *ALL* files uploaded")
  .option("--remove-deleted", "Removes previously uploaded (but now deleted) items from the manifest")
  .option("--force-chunking", "Forces usage of chunking for all files regardless of size");
// Define commands
// uses NPM view to query the package's version.
program.version(Irys.VERSION, "-v, --version", "Gets the current package version of the Irys client");

// Balance command - gets the provided address' balance on the specified bundler
program
  .command("balance")
  .description("Gets the specified user's balance for the current Irys node")
  .argument("<address>", "address")
  .action(async (address: string) => {
    try {
      options.address = balpad ? address.substring(1) : address;
      const Irys = await init(options, "balance");
      const balance = await Irys.utils.getBalance(options.address);
      console.log(`Balance: ${balance} ${Irys.currencyConfig.base[0]} (${Irys.utils.unitConverter(balance).toFixed()} ${Irys.currency})`);
    } catch (err: any) {
      console.error(`Error whilst getting balance: ${options.debug ? err.stack : err.message} `);
      return;
    }
  });

// Withdraw command - sends a withdrawal request for n base units to the specified bundler for the loaded wallet
program
  .command("withdraw")
  .description("Sends a fund withdrawal request")
  .argument("<amount>", "amount to withdraw in currency base units")
  .action(async (amount: string) => {
    try {
      const Irys = await init(options, "withdraw");
      const confirmed = await confirmation(
        `Confirmation: withdraw ${amount} ${Irys.currencyConfig.base[0]} from ${Irys.api.config.host} (${await Irys.utils.getBundlerAddress(
          Irys.currency,
        )})?\n Y / N`,
      );
      if (confirmed) {
        const res = await Irys.withdrawBalance(new BigNumber(amount));
        console.log(
          `Withdrawal request for ${res?.requested} ${Irys.currencyConfig.base[0]} successful\nTransaction ID: ${res?.tx_id} with network fee ${res?.fee} for a total cost of ${res?.final} `,
        );
      } else {
        console.log("confirmation failed");
      }
    } catch (err: any) {
      console.error(`Error whilst sending withdrawal request: ${options.debug ? err.stack : err.message} `);
      return;
    }
  });

// Upload command - Uploads a specified file to the specified bundler using the loaded wallet.
program
  .command("upload")
  .description("Uploads a specified file")
  .argument("<file>", "relative path to the file you want to upload")
  .action(async (file: string) => {
    try {
      const Irys = await init(options, "upload");
      const res = await Irys.uploadFile(file);
      console.log(`Uploaded to https://arweave.net/${res?.id}`);
    } catch (err: any) {
      console.error(`Error whilst uploading file: ${options.debug ? err.stack : err.message} `);
      return;
    }
  });

program
  .command("upload-dir")
  .description("Uploads a folder (with a manifest)")
  .argument("<folder>", "relative path to the folder you want to upload")
  .action(async (folder: string) => {
    await uploadDir(folder);
  });

// Deploy command - DEPRECATED
program
  .command("deploy")
  .description("(DEPRECATED - use the functionally identical 'upload-dir' instead.) Deploys a folder (with a manifest) to the specified bundler")
  .argument("<folder>", "relative path to the folder you want to deploy")
  .action(async (folder: string) => {
    console.warn("WARN: Deploy is deprecated, use the functionally identical 'upload-dir' instead.");
    await uploadDir(folder);
  });

async function uploadDir(folder: string): Promise<void> {
  try {
    const bundler = await init(options, "upload");
    const res = await bundler.uploadFolder(folder, {
      indexFile: options.indexFile,
      batchSize: +options.batchSize,
      interactivePreflight: options.confirmation,
      keepDeleted: !options.removeDeleted,
      logFunction: async (log): Promise<void> => {
        console.log(log);
      },
    });
    if (!res) return console.log("Nothing to upload");
    console.log(`Uploaded to https://arweave.net/${res.id}`);
  } catch (err: any) {
    console.error(`Error whilst uploading ${folder} - ${options.debug ? err.stack : err.message}`);
  }
}

program
  .command("fund")
  .description("Funds your account with the specified amount of atomic units")
  .argument("<amount>", "Amount to add in atomic units")
  .action(async (amount: string) => {
    try {
      if (isNaN(+amount)) throw new Error("Amount must be an integer");
      const Irys = await init(options, "fund");
      const confirmed = await confirmation(
        `Confirmation: send ${amount} ${Irys.currencyConfig.base[0]} (${Irys.utils.unitConverter(amount).toFixed()} ${Irys.currency}) to ${
          Irys.api.config.host
        } (${await Irys.utils.getBundlerAddress(Irys.currency)})?\n Y / N`,
      );
      if (confirmed) {
        const tx = await Irys.fund(new BigNumber(amount), options.multiplier);
        console.log(`Funding receipt: \nAmount: ${tx.quantity} with Fee: ${tx.reward} to ${tx.target} \nTransaction ID: ${tx.id} `);
      } else {
        console.log("confirmation failed");
      }
    } catch (err: any) {
      console.error(`Error whilst funding: ${options.debug ? err.stack : err.message} `);
      return;
    }
  });

program
  .command("price")
  .description("Check how much of a specific currency is required for an upload of <amount> bytes")
  .argument("<bytes>", "The number of bytes to get the price for")
  .action(async (bytes: string) => {
    try {
      if (isNaN(+bytes)) throw new Error("Amount must be an integer");
      const Irys = await init(options, "price");
      await Irys.utils.getBundlerAddress(options.currency); // will throw if the bundler doesn't support the currency
      const cost = await Irys.utils.getPrice(options.currency, +bytes);
      console.log(
        `Price for ${bytes} bytes in ${options.currency} is ${cost.toFixed(0)} ${Irys.currencyConfig.base[0]} (${Irys.utils
          .unitConverter(cost)
          .toFixed()} ${Irys.currency})`,
      );
    } catch (err: any) {
      console.error(`Error whilst getting price: ${options.debug ? err.stack : err.message} `);
      return;
    }
  });

/**
 * Interactive CLI prompt allowing a user to confirm an action
 * @param message the message specifying the action they are asked to confirm
 */
async function confirmation(message: string): Promise<boolean> {
  if (!options?.confirmation) {
    return true;
  }
  const answers = await inquirer.prompt([{ type: "input", name: "confirmation", message }]);
  return answers.confirmation.toLowerCase() == "y";
}

/**
 * Initialisation routine for the CLI, mainly for initialising a Irys instance
 * @param opts the parsed options from the cli
 * @returns a new Irys instance
 */
async function init(opts, operation): Promise<Irys> {
  let wallet;
  let bundler: NodeIrys;
  // every option needs a host and currency so ensure they're present
  if (!opts.host) {
    throw new Error("Host parameter (-h) is required!");
  }
  if (!opts.currency) {
    throw new Error("currency flag (-c) is required!");
  }
  // some operations do not require a wallet
  if (!["balance", "price"].includes(operation)) {
    // require a wallet
    if (opts.wallet === "default") {
      // default to wallet.json under the right conditions
      if (opts.currency === "arweave" && (await checkPath("./wallet.json"))) {
        wallet = await loadWallet("./wallet.json");
      } else {
        throw new Error("Wallet (-w) required for this operation!");
      }
    } else {
      // remove padding if present
      wallet = await loadWallet(walpad ? opts.wallet.substring(1) : opts.wallet);
    }
  }
  try {
    // create and ready the Irys instance
    bundler = new Irys({
      url: opts.host,
      currency: opts.currency.toLowerCase(),
      key: wallet ?? "",
      config: {
        providerUrl: opts.providerUrl,
        contractAddress: opts.contractAddress,
      },
    });
    await bundler.ready();
  } catch (err: any) {
    throw new Error(`Error initialising Irys client - ${options.debug ? err.stack : err.message}`);
  }
  // log the loaded address
  if (wallet && bundler.address) {
    console.log(`Loaded address: ${bundler.address}`);
  }

  if (opts.contentType) {
    bundler.uploader.contentType = opts.contentType;
  }
  if (opts.forceChunking) {
    bundler.uploader.useChunking = true;
  }

  return bundler;
}

/**
 * Loads a wallet file from the specified path into a JWK interface
 * @param path path to the JWK file
 * @returns JWK interface
 */
async function loadWallet(path: string): Promise<any> {
  if (await checkPath(path)) {
    if (options.debug) {
      console.log("Loading wallet file");
    }
    return JSON.parse(readFileSync(path).toString());
  } else {
    if (options.debug) {
      console.log("Assuming raw key instead of keyfile path");
    }
    return path;
  }
}

const options = program.opts();

const isScript = require.main === module;
if (isScript) {
  // to debug CLI: log process argv, load into var, and run in debugger.

  // console.log(JSON.stringify(process.argv));
  // process.exit(1);

  // replace this with dumped array. (make sure to append/include --no-confirmation)
  const argv = process.argv;

  // padding hack
  // this is because B64URL strings can start with a "-" which makes commander think it's a flag
  // so we pad it with a char that is not part of the B64 char set to prevent wrongful detection
  // and then remove it later.

  const bal = argv.indexOf("balance") + 1;
  if (bal != 0 && argv[bal] && /-{1}[a-z0-9_-]{42}/i.test(argv[bal])) {
    balpad = true;
    argv[bal] = "[" + argv[bal];
  }
  // padding hack to wallet addresses as well
  const wal = (!argv.includes("-w") ? argv.indexOf("--wallet") : argv.indexOf("-w")) + 1;
  if (wal != 0 && argv[wal] && /-{1}.*/i.test(argv[wal])) {
    walpad = true;
    argv[wal] = "[" + argv[wal];
  }
  // pass the CLI our argv
  program.parse(argv);
}

export const exportForTesting = {
  path: __filename,
};
