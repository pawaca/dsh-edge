export interface BundledComponent {
  author?: string | { name?: string }
  license: string
  name: string
  path: string
  repository?: string | { url?: string }
  version: string
}

export interface LegalDocumentUse {
  file: string
  name: string
  version: string
}

export interface LegalDocument {
  id: string
  text: string
  uses: LegalDocumentUse[]
}

export declare function collectLicenseDocuments(components: BundledComponent[]): LegalDocument[]
export declare function renderBundledTerms(components: BundledComponent[]): string
