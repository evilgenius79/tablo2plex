/**
 * @file Basic linting file for coding guidelines.
 */

const jsdoc = require('eslint-plugin-jsdoc');

module.exports = [
  jsdoc.configs['flat/recommended'],
  {
    "rules": {
      // (markdownlint rules like MD033 live in .markdownlint.json, not here)
      "jsdoc/require-description": 'warn', // ensure that a JSDoc message is needed for functions
      "jsdoc/tag-lines": ["warn", "always", { "startLines": null, }], // turn off spacing for JSDoc
      "semi": [2, "always"], // please use ; after statement
      "no-unexpected-multiline": "error", // please assign on the same line
      "no-unreachable": "error", // no code after returns
      "prefer-const": "error", // define all let or use var or const
      "no-unused-vars": ["warn", {
        // var must be used unless name's are defined in varsIgnorePattern
        // Most here for JSDoc reason
        // Add an underscore at the start of the name to get around this for any reason
        "vars": "all",
        "args": "none",
        "caughtErrors": "none",
        "varsIgnorePattern": "^_",
        "ignoreRestSiblings": true,
        "reportUsedIgnorePattern": false
      }],
    },
    "plugins": {
      jsdoc
    },
    "files": ["**/*.js", "**/*.cjs"],
    "languageOptions": {
      "sourceType": "commonjs"
    }
  }
];