export class BudgetError extends Error {
  constructor(message, code) { super(message); this.name = 'BudgetError'; this.status = 429; this.code = code; }
}

export class BudgetLedger {
  constructor({ limits, initial, today, persist }) {
    this.limits = Object.freeze({ ...limits });
    this.today = today;
    this.persist = persist;
    this.state = initial?.day === today() ? structuredClone(initial) : this.empty();
  }

  empty() { return { day: this.today(), calls: 0, reservedInputTokens: 0, reservedOutputTokens: 0, meetings: {} }; }

  snapshot() {
    if (this.state.day !== this.today()) this.state = this.empty();
    return structuredClone({ ...this.state, limits: this.limits });
  }

  reserve(meetingId, inputTokens, outputTokens) {
    if (this.state.day !== this.today()) this.state = this.empty();
    const meetingCalls = Number(this.state.meetings[meetingId] || 0);
    if (inputTokens > this.limits.inputPerCall) throw new BudgetError(`Entrada estimada em ${inputTokens} tokens; limite ${this.limits.inputPerCall}.`, 'INPUT_LIMIT');
    if (outputTokens > this.limits.outputPerCall) throw new BudgetError(`Saída solicitada excede ${this.limits.outputPerCall} tokens.`, 'OUTPUT_LIMIT');
    if (this.state.calls >= this.limits.dailyCalls) throw new BudgetError('Teto diário local atingido.', 'DAILY_LIMIT');
    if (meetingCalls >= this.limits.meetingCalls) throw new BudgetError('Teto local desta reunião atingido.', 'MEETING_LIMIT');
    // Reserva e persiste antes de devolver; duas requisições no mesmo event loop não veem o mesmo saldo.
    this.state.calls += 1;
    this.state.reservedInputTokens += inputTokens;
    this.state.reservedOutputTokens += outputTokens;
    this.state.meetings[meetingId] = meetingCalls + 1;
    this.persist(this.snapshot());
    return { input: inputTokens, output: outputTokens };
  }
}
