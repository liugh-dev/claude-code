import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'providers',
  description: '管理 API provider（list / add / remove / use）',
  argumentHint: '[list|add|remove|use] [args]',
  load: () => import('./providers.js'),
} satisfies Command
