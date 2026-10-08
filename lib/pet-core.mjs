/** Small, deterministic state machine. It observes DSH; it cannot execute or approve work. */
export class PetCore {
  constructor({ pet = {}, now = Date.now } = {}) {
    this.now = now;
    const savedName = typeof pet.name === 'string' ? pet.name.trim().slice(0, 24) : '';
    this.pet = {
      name: savedName && savedName !== '小鲸' ? savedName : '大肥鱼',
      feeds: counter(pet.feeds),
      pets: counter(pet.pets),
    };
    this.turns = new Map();
    this.jobs = new Map();
    this.sequences = new Map();
    this.settledJobs = new Set();
    this.desktopUntil = 0;
    this.transient = null;
    this.activity = { name: 'idle', since: now(), until: null, seq: 0 };
    this.listeners = new Set();
    this.desktopVisible = false;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot() {
    this.tick();
    return {
      pet: { ...this.pet },
      activity: { ...this.activity },
      presence: { desktop: this.desktopUntil > this.now() },
    };
  }

  emit() {
    const state = {
      pet: { ...this.pet },
      activity: { ...this.activity },
      presence: { desktop: this.desktopUntil > this.now() },
    };
    for (const listener of this.listeners) listener(state);
  }

  interact(action) {
    if (action !== 'feed' && action !== 'pet') throw new TypeError('Unknown interaction');
    const key = action === 'feed' ? 'feeds' : 'pets';
    this.pet[key] = Math.min(Number.MAX_SAFE_INTEGER, this.pet[key] + 1);
    this.emit();
    return this.snapshot();
  }

  presence(desktop) {
    if (typeof desktop !== 'boolean') throw new TypeError('desktop must be boolean');
    this.desktopUntil = desktop ? this.now() + 15_000 : 0;
    this.tick();
    return this.snapshot();
  }

  tick() {
    const now = this.now();
    if (this.transient?.until <= now) this.transient = null;
    let name = 'idle';
    let until = null;
    const turns = [...this.turns.values()];
    if (turns.some(turn => turn.approvals.size)) name = 'waiting';
    else if (turns.some(turn => turn.tools.size) || [...this.jobs.values()].some(list => list.size)) name = 'working';
    else if (turns.some(turn => turn.running)) name = 'thinking';
    else if (this.transient) ({ name, until } = this.transient);
    const desktop = this.desktopUntil > now;
    if (this.activity.name !== name || this.activity.until !== until) {
      this.activity = { name, since: now, until, seq: this.activity.seq + 1 };
      this.desktopVisible = desktop;
      this.emit();
    } else if (desktop !== this.desktopVisible) {
      this.desktopVisible = desktop;
      this.emit();
    }
  }

  notice(name, duration = 6_000, sessionId) {
    this.transient = { name, until: this.now() + duration, sessionId };
    this.tick();
  }

  sessionEvent(session, event) {
    const id = String(session?.id ?? 'unknown');
    if (!event || typeof event.type !== 'string') return;
    if (Number.isSafeInteger(event.seq)) {
      if (event.seq <= (this.sequences.get(id) ?? -1)) return;
      this.sequences.set(id, event.seq);
    }
    const data = event.data ?? {};
    let turn = this.turns.get(id);
    if (event.type === 'turn/start') {
      this.transient = null;
      // Approval requests have their own lifecycle. A new turn does not decide
      // pending requests left by an earlier turn in this session.
      this.turns.set(id, { number: data.turn, running: true, tools: new Set(), approvals: turn?.approvals ?? new Set() });
    } else if (event.type === 'turn/end') {
      // A stale close must not stop a newer turn in the same session.
      if (turn && turn.number !== undefined && data.turn !== undefined && turn.number !== data.turn) return;
      if (turn?.approvals.size) {
        turn.running = false;
        turn.tools.clear();
      } else this.turns.delete(id);
      const reason = data.reason?.kind ?? data.reason;
      if (reason === 'completed') this.notice('celebrate');
      else if (reason === 'error' || reason === 'max-tokens') this.notice('error', 8_000);
      else if (reason === 'blocked') {
        // Real pending approvals wait without a deadline, until their exact
        // decision arrives. Only a generic blocked turn gets a short notice.
        if (turn?.approvals.size) this.transient = null;
        else this.notice('waiting', 8_000, id);
      }
      else this.transient = null;
    } else if (event.type === 'approval/asked') {
      if (!turn) {
        turn = { number: data.turn, running: false, tools: new Set(), approvals: new Set() };
        this.turns.set(id, turn);
      }
      turn.approvals.add(String(data.id));
    } else if (event.type === 'approval/decided') {
      turn?.approvals.delete(String(data.id));
      if (turn && !turn.running && !turn.approvals.size) this.turns.delete(id);
      if (this.transient?.name === 'waiting' && this.transient.sessionId === id) this.transient = null;
    } else if (event.type === 'tool/call' && turn) {
      turn.tools.add(String(data.callId));
    } else if (event.type === 'tool/result') {
      const callId = data.callId ?? data.message?.source?.callId
        ?? data.message?.content?.find(block => block.type === 'tool-result')?.toolCallId;
      turn?.tools.delete(String(callId));
    }
    this.tick();
  }

  sessionDisposed(session) {
    this.turns.delete(String(session?.id ?? 'unknown'));
    this.tick();
  }

  jobsChanged(owner, snapshots) {
    const key = String(owner?.session?.id ?? owner?.sessionId ?? 'unowned');
    this.jobs.set(key, new Set(snapshots
      .filter(job => job.status === 'running' || job.status === 'stopping')
      .map(job => String(job.id))));
    this.tick();
  }

  jobDone(job) {
    const key = `${job.id}:${job.startedAt}`;
    if (this.settledJobs.has(key)) return;
    this.settledJobs.add(key);
    if (this.settledJobs.size > 1_000) this.settledJobs.delete(this.settledJobs.values().next().value);
    for (const jobs of this.jobs.values()) jobs.delete(String(job.id));
    if (job.status === 'completed') this.notice('celebrate');
    else if (job.status === 'failed') this.notice('error', 8_000);
    else this.tick();
  }
}

function counter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
