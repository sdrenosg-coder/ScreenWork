# Zipy AI — on-premise operator runbook

A task-oriented companion to `on-prem.md`. Each section is a situation the
operator may face and the exact commands to inspect and resolve it. Nothing
here invents a capability the platform does not have; where a fix requires a
customer-supplied dependency the runbook points at `external-setup.md`.

---

## 1. "The web app will not start"

Symptom: `systemctl status zipy-web` shows repeated restarts; the journal
carries a `Zipy AI configuration error` line.
