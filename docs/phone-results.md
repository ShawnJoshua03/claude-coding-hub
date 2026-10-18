# iPhone feasibility results

Status: NOT YET TESTED on the user's iPhone. This file is a checklist, not evidence of completion.

| Test | Result | Evidence |
|---|---|---|
| Pair native Claude Remote Control | Unverified | Human native trust/enable/pairing required |
| Synthetic accept/decline form renders | Unverified | No action executes in test_phone_form |
| Real Codex summary in same Claude conversation | Unverified on phone | Separate native smoke can verify CLI connectivity only |
| Real worker command approve-once | Unverified | Must show exact action and receive human answer |
| Real worker command denial stops action | Unverified on phone | Fake protocol integration covers adapter mapping only |
| Real worker question | Unverified | Fake protocol integration covers adapter mapping only |
| Phone lock/cellular disconnect and reconnect | Unverified | Host must remain awake and online |
| Completion after lead's initial turn ends | Unverified | Try native long-tool-call background notification |
| Cancellation with pending decision | Unverified on phone | Fake protocol regression covers late-answer race |
| Claude implements, Codex reviews, Claude integrates | Unverified | Use the README engineering scenario |
