/**
 * Direct-build replacement for Computer's embedded Dynamic Worker modules.
 *
 * Direct deployments have no Loader binding, so they cannot select
 * `WorkerShellBackend`. The alias keeps Computer's filesystem and command
 * adapters available without uploading an unreachable shell runtime.
 */
const directShellCore = Object.freeze({})

export default directShellCore
