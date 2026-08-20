/** Build-owned release metadata shared by the Edge host and browser profile. */

import edgePackage from '../package.json' with { type: 'json' }

/** Version of the deployable dsh-edge artifact. */
export const DSH_EDGE_VERSION = edgePackage.version

/** DeepSeek Harness version this artifact was assembled from. */
export const DSH_EDGE_UPSTREAM_VERSION = edgePackage.dshEdge.upstreamVersion
