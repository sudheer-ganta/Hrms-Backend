import { EventEmitter } from 'events';

export interface DataRevision {
  revision: number;
  lastModified: string;
  scope: string;
}

class RevisionService extends EventEmitter {
  private revision: number = 1;
  private lastModified: string = new Date().toISOString();

  public getRevision(): DataRevision {
    return {
      revision: this.revision,
      lastModified: this.lastModified,
      scope: 'init',
    };
  }

  public bump(scope: string = 'general'): DataRevision {
    this.revision++;
    this.lastModified = new Date().toISOString();
    const payload: DataRevision = {
      revision: this.revision,
      lastModified: this.lastModified,
      scope,
    };
    this.emit('change', payload);
    return payload;
  }
}

export const revisionService = new RevisionService();
