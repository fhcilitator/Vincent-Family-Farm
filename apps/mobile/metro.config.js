const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// This app lives in an npm workspace, so its dependencies are hoisted to the
// repo root and @vff/client-core is a symlink into packages/. Metro only
// watches the project directory by default and would miss both.
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// Without this, Metro walks up the tree on a miss and can resolve two copies
// of React — the classic monorepo hooks-dispatcher crash.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
