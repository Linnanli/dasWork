#!/usr/bin/env node

import { developmentCliMain } from "./development-cli.mjs";

await developmentCliMain("import", process.argv.slice(2));
