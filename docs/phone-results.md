# iPhone feasibility results

Status: partly tested on the user's iPhone (2026-10-19); rows below show what was observed. This file is a checklist, not evidence of completion.

| Test | Result | Evidence |
|---|---|---|
| Pair native Claude Remote Control | Passed (human observed, 2026-10-19) | Session "Claude coding hub pilot" appeared in the iPhone Claude app; messages sent from the phone reached the laptop session |
| Synthetic accept/decline form renders | FAILED on phone (human observed, 2026-10-19) | Two attempts. The native tool-permission prompt ("Test Phone Form requests permission": Allow once / Always allow / Deny) reached the phone and Allow once worked from it. The elicitation form then showed on the laptop (decision + note, Accept/Decline) but never rendered on the phone, even after reopening the app. The first attempt showed on the phone as a rejected tool call. Hub side is fine; this is the phone interface not showing MCP form prompts. |
| Real Codex summary in same Claude conversation | Unverified on phone | Separate native smoke can verify CLI connectivity only |
| Real worker command approve-once | Unverified | Must show exact action and receive human answer |
| Real worker command denial stops action | Unverified on phone | Fake protocol integration covers adapter mapping only |
| Real worker question | Unverified | Fake protocol integration covers adapter mapping only |
| Phone lock/cellular disconnect and reconnect | Unverified | Host must remain awake and online |
| Completion after lead's initial turn ends | Unverified | Try native long-tool-call background notification |
| Cancellation with pending decision | Unverified on phone | Fake protocol regression covers late-answer race |
| Claude implements, Codex reviews, Claude integrates | Unverified | Use the README engineering scenario |
