#!/usr/bin/env node

import { developmentCliMain } from "./development-cli.mjs";

await developmentCliMain("refresh", process.argv.slice(2));
