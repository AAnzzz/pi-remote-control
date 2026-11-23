const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const workspaceRoot = path.resolve(__dirname, "../..");
// The workspace root covers every local package, including installs with no root node_modules.
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [...new Set([
  path.join(__dirname, "node_modules"),
  path.join(workspaceRoot, "node_modules"),
  ...config.resolver.nodeModulesPaths,
])];
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
