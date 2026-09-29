/** Type declarations for resolve-package.js so its unit test can import it. */
export declare function packageDir(name: string, fromDir?: string): string | undefined
export declare function packagePath(name: string, ...segments: string[]): string | undefined
export declare function packageVersion(name: string, fromDir?: string): string
