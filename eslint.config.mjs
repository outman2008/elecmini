// ElecMini JS 质量门禁：只检查「正确性」，风格交给 Prettier。
// 历史代码存在大量风格差异，故不启用 eslint:recommended 全量规则，
// 仅保留会导致真实 bug 的硬错误规则，确保 CI 稳定且有意义。
//
// 模块类型：shim/src + migrate/assess.js 为 ESM；runtime/pack/contract 等为 CJS。
import globals from 'globals';

const nodeGlobals = { ...globals.node, ...globals.es2021 };

// 正确性规则（不含风格）
const correctnessRules = {
  'no-undef': 'error',
  'no-unreachable': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-obj-calls': 'error',
  'no-const-assign': 'error',
  'no-func-assign': 'error',
  'no-self-assign': 'error',
  'no-cond-assign': 'error',
  'no-unused-vars': 'off',
  'no-empty': 'off',
};

export default [
  {
    ignores: [
      '**/node_modules/**',
      'dist/**',
      'target/**',
      'docs/**',
      '**/results/**',
      '**/*.md',
    ],
  },
  {
    files: ['shim/src/**/*.js', 'migrate/assess.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: correctnessRules,
  },
  {
    files: ['runtime/**/*.js', 'pack/**/*.js', 'contract/**/*.js', 'migrate/gen-probe.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
    rules: correctnessRules,
  },
];
