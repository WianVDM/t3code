interface WorkspacePackage {
  readonly name: string;
  readonly dir: string;
  readonly hasTest: boolean;
  readonly deps: ReadonlyArray<string>;
}

export function readWorkspace(): Array<WorkspacePackage>;

// One job entry of GitHub's toJSON(needs), as the Check job passes it.
export interface JobNeed {
  readonly result?: string | undefined;
  readonly outputs?: Readonly<Record<string, string | undefined>> | undefined;
}

// The Check job's expected-job map: gates null means the job always runs.
export const EXPECTED_JOBS: Readonly<
  Record<string, { readonly gates: ReadonlyArray<string> | null }>
>;

// Shared fail-closed result policy; returns one problem per violation.
export function checkJobResults(
  needs: Readonly<Record<string, JobNeed | undefined>>,
): Array<string>;

export function decide(
  files: ReadonlyArray<string> | null,
  packages: ReadonlyArray<WorkspacePackage>,
  full: boolean,
): {
  affected: Array<string>;
  outputs: {
    typecheck: boolean;
    build: boolean;
    test: boolean;
    test_packages: string;
    test_web: boolean;
    test_server: boolean;
    rust: boolean;
    release_smoke: boolean;
    windows: boolean;
    windows_packages: string;
  };
};

// ++ boundary infrastructure paths: a change to any of them runs every job.
export const BOUNDARY_INFRASTRUCTURE: ReadonlySet<string>;
