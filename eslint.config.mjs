import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'
import importPlugin from 'eslint-plugin-import'

export default [
	js.configs.recommended,
	...tseslint.configs.recommended,
	prettier,
	{
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'module',
		},
		plugins: {
			import: importPlugin,
		},
		settings: {
			// Without the TS resolver the rule stays silent on extensionless
			// imports — that is, on all of ours. A silent guard is worse than
			// none.
			'import/resolver': {
				typescript: {
					project: ['*/*/tsconfig.json'],
					noWarnOnMultipleProjects: true,
				},
			},
		},
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'warn',
				{ argsIgnorePattern: '^_' },
			],
			// The monorepo's single loophole: a relative path can reach into a
			// foreign package, bypassing the dependency graph. The rule catches
			// exactly that — an import resolving outside the current package's
			// package.json. A glob on directory names won't do here: it cannot
			// tell the root plugins/ from the core's internal src/plugins/.
			'import/no-relative-packages': 'error',
		},
	},
	{
		// Scripts in scripts/ are run by node directly, without TS tooling.
		files: ['scripts/**/*.mjs'],
		languageOptions: {
			globals: { process: 'readonly', console: 'readonly' },
		},
	},
	{
		// .venv is the Python scoring service: sklearn ships JS for its HTML
		// model representation, and eslint duly complains about it.
		ignores: ['**/dist', '**/node_modules', '**/generated', '**/.venv', 'data'],
	},
]
