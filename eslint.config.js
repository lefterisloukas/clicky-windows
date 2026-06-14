// ESLint v9 flat config for the clicky-windows TypeScript codebase.
//
// The original repo had `@typescript-eslint` packages installed but no
// config file at all, so `npm run lint` failed with ESLint 9's
// "couldn't find an eslint.config.(js|mjs|cjs)" error. This file restores
// a working config using FlatCompat to wrap the legacy
// `plugin:@typescript-eslint/recommended` rule set.
const { FlatCompat } = require("@eslint/eslintrc");

const compat = new FlatCompat();

module.exports = [
  {
    ignores: [
      "dist/**",
      "out/**",
      "node_modules/**",
      ".webpack/**",
      "release/**",
      "**/*.d.ts",
    ],
  },
  ...compat.extends("plugin:@typescript-eslint/recommended"),
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
  },
];
