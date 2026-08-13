import { rmSync, renameSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getMacroDefines, DEFAULT_BUILD_FEATURES } from './scripts/defines.ts'

// Supported targets with Bun target format
const TARGETS = {
  'linux-x64': { ext: '', bunTarget: 'bun-linux-x64' },
  'linux-arm64': { ext: '', bunTarget: 'bun-linux-arm64' },
  'windows-x64': { ext: '.exe', bunTarget: 'bun-windows-x64' },
} as const

type TargetKey = keyof typeof TARGETS

// Parse CLI args
const args = process.argv.slice(2)
const targetArg = args.find(a => a.startsWith('--target='))?.split('=')[1]
const allFlag = args.includes('--all')
const outdirArg = args.find(a => a.startsWith('--outdir='))?.split('=')[1]
const helpFlag = args.includes('--help') || args.includes('-h')

if (helpFlag) {
  console.log(`
Usage: bun run compile.ts [options]

Options:
  --target=<name>   Build for specific target (linux-x64, linux-arm64, windows-x64)
  --all             Build for all supported targets
  --outdir=<dir>    Output directory (default: dist/compiled)
  --help, -h        Show this help

Examples:
  bun run compile.ts --target=linux-x64
  bun run compile.ts --all
`)
  process.exit(0)
}

// Determine targets to build
let targetsToBuild: TargetKey[] = []
if (allFlag) {
  targetsToBuild = Object.keys(TARGETS) as TargetKey[]
} else if (targetArg && targetArg in TARGETS) {
  targetsToBuild = [targetArg as TargetKey]
} else {
  console.error('Error: Specify --target=<name> or --all')
  console.error('Available targets:', Object.keys(TARGETS).join(', '))
  process.exit(1)
}

const outdir = outdirArg || 'dist/compiled'
mkdirSync(outdir, { recursive: true })

// Collect features
const envFeatures = Object.keys(process.env)
  .filter(k => k.startsWith('FEATURE_'))
  .map(k => k.replace('FEATURE_', ''))
const features = [...new Set([...DEFAULT_BUILD_FEATURES, ...envFeatures])]

// Build each target
for (const target of targetsToBuild) {
  const { ext, bunTarget } = TARGETS[target]
  const outputFile = join(outdir, `ccb-${target}${ext}`)

  console.log(`\nBuilding for ${target} (target: ${bunTarget})...`)

  // Clean output for this target
  rmSync(outputFile, { force: true })

  // Build using Bun API with cross-compilation target
  const result = await Bun.build({
    entrypoints: ['src/entrypoints/cli.tsx'],
    target: 'bun',
    compile: {
      target: bunTarget,
      outfile: outputFile,
    },
    splitting: false,
    define: {
      ...getMacroDefines(),
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    features,
    env: 'disable',
    minify: true,
  })

  if (!result.success) {
    console.error(`Build failed for ${target}:`)
    for (const log of result.logs) {
      console.error(log)
    }
    continue
  }

  if (existsSync(outputFile)) {
    console.log(`✓ Built: ${outputFile}`)
  } else {
    console.error(`Output file not found: ${outputFile}`)
  }
}

console.log('\nDone!')
