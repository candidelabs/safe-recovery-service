// ESLint flat config (ESLint 9). Kept small: `tsc --noEmit` (strict) does the type checking, and the
// rules here guard conventions tsc cannot: no console output outside the logging module (every line
// must go through the logger) and no dead imports.
const tsParser = require("@typescript-eslint/parser");
const tsPlugin = require("@typescript-eslint/eslint-plugin");
const unusedImports = require("eslint-plugin-unused-imports");
const prettier = require("eslint-config-prettier");

module.exports = [
  { ignores: ["build/**", "prisma/**"] },
  { linterOptions: { reportUnusedDisableDirectives: "off" } },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
    plugins: { "@typescript-eslint": tsPlugin, "unused-imports": unusedImports },
    rules: {
      "no-console": "error",
      "unused-imports/no-unused-imports": "error",
    },
  },
  {
    // the logging module owns the console bridge and the selftest prints its verdict;
    // the Jest suites print their progress
    files: ["src/logging/**/*.ts", "test/**/*.ts"],
    rules: { "no-console": "off" },
  },
  prettier,
];
