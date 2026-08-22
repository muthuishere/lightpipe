#!/usr/bin/env node
import { main } from "../src/cli.js";

main(process.argv.slice(2)).then(
  (code) => {
    if (typeof code === "number" && code !== 0) process.exit(code);
  },
  (err) => {
    console.error(`lightpipe: ${err?.stack ?? err}`);
    process.exit(1);
  },
);
