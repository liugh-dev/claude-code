import type { ToSourceFilePath } from '../util/to-source-path.ts';
import type { ResolveModule } from './visitors/helpers.ts';
export declare function createCustomModuleResolver(compilerOptions: {
    paths?: Record<string, string[]>;
    rootDirs?: string[];
}, customCompilerExtensions: string[], toSourceFilePath: ToSourceFilePath): ResolveModule;
