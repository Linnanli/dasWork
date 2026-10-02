export const supportedRuntimeTargets = Object.freeze([
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
  "linux-x64",
]);

export function parseRuntimeTargetOption(argv) {
  let target;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") {
      target = argv[index + 1];
      if (!target || target.startsWith("--")) {
        throw new Error("Primary Runtime target is required after --target.");
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("--target=")) {
      target = argument.slice("--target=".length);
      if (!target) throw new Error("Primary Runtime target cannot be empty.");
    }
  }
  return target;
}

export function currentRuntimeTarget({
  platform = process.platform,
  architecture = process.arch,
} = {}) {
  const target = `${platform}-${architecture}`;
  if (!supportedRuntimeTargets.includes(target)) {
    throw new Error(
      `AT-RT-BUILD-01 blocked: ${target} is not a supported native Runtime build target.`,
    );
  }
  return target;
}

export function assertNativeRuntimeTarget(
  requestedTarget,
  environment = undefined,
) {
  const nativeTarget = currentRuntimeTarget(environment);
  if (requestedTarget !== undefined && requestedTarget !== nativeTarget) {
    throw new Error(
      `AT-RT-BUILD-01 blocked: requested ${requestedTarget} cannot claim native verification on ${nativeTarget}.`,
    );
  }
  return nativeTarget;
}
