// A deliberately broken tool gate: it loads without error, never announces
// itself, and never blocks anything. It stands for "Pi came up, but not with
// our gate": a renamed event, a gate that failed quietly, a different file.
// The shim must send such a Pi no turn at all.
//
// It imports nothing, so a real Pi can load it.
export default function silentGate(): void {}
