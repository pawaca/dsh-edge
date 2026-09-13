import { Context, Service } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fileUploads: EdgeFileUploadsStub
  }
}

export class EdgeFileUploadsStub extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fileUploads')
  }

  resolve(): never {
    throw new Error('file uploads are not supported on Edge')
  }

  bindPrompt(): { commit(): void; [Symbol.dispose](): void } {
    return { commit() {}, [Symbol.dispose]() {} }
  }

  retirePrompt(): void {}

  registerAgentResolver(): () => void {
    return () => {}
  }
}

export default EdgeFileUploadsStub
