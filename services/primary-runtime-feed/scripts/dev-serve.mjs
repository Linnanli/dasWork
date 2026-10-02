#!/usr/bin/env node

import { developmentCliMain } from "./development-cli.mjs";

await developmentCliMain("serve", process.argv.slice(2));
