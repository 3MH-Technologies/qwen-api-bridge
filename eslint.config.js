import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/", "captures/", "__pycache__/", "*.har"],
  },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off",
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
      "no-var": "error",
    },
  },
  {
    // The in-page bundle runs in the browser with its own globals.
    files: ["src/inpage.js"],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
];
