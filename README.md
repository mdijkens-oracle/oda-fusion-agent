# Oracle Digital Assistant to Fusion AI Agent Studio

Invoke a published Fusion AI Agent Studio workflow from Oracle Digital Assistant
using reusable custom components. `callAgent` handles token acquisition, reuse,
asynchronous invocation and bounded polling. The optional `getToken` component
provides a token for custom REST calls.

```text
Oracle Digital Assistant -> custom component -> Fusion AI Agent Studio workflow
                         <- result and status <-
```

The component package and public component names remain `mdFusionAgent`.
The intended GitHub repository name is `oda-fusion-agent`.

## Demo video

An ODA-to-Fusion walkthrough video has been recorded. A link will be added once
it is published. Video files and production assets are not included here.

## Prerequisites

* An Oracle Digital Assistant skill with permission to manage its custom component service.
* An accessible Fusion environment with an existing published AI Agent Studio workflow.
* A Fusion account allowed to run that workflow; supply your own connection settings.
* Node.js 18 or newer for local tests and packaging. No runtime npm dependencies.

This is a demonstration integration. It does not create a Fusion workflow or
provide access to a shared Fusion environment. Keep credentials in private ODA
configuration; do not put them in source control, screenshots or chat responses.

## Build the component package

From this project folder, run:

```powershell
node --test
npm pack --ignore-scripts
```

Upload the generated `mdFusionAgent-3.0.0.tgz` to your ODA embedded custom
component service. The archive is a generated local artifact and is excluded
from Git. For updates to an existing service, follow the migration notes below.

See [Oracle's custom component documentation](https://docs.oracle.com/en-us/iaas/digital-assistant/doc/implement-custom-components.html)
for the ODA service setup. Running these local commands does not contact Fusion
or update an ODA service.

## Component reference: mdFusionAgent 3.0.0

Reusable ODA components with grouped configuration and automatic token reuse.

## Upload and migrate

Update your embedded component service with `mdFusionAgent-3.0.0.tgz`.
This version changes the component inputs. Reconfigure the existing call state:
remove old individual fields, or recreate just that state if ODA retains them after refresh.
The component names and output Maps are unchanged.

Version 3.0.0 has been locally tested and SDK-validated. The author confirmed on 2026-10-26 that the current integration is tested and working in ODA.

## callAgent: five fields

| Property | Required | Value |
| --- | --- | --- |
| connection | Yes | Map / JSON object containing baseUrl, username, password |
| workflow | Yes | Workflow code, e.g. DEMO_WORKFLOW |
| resultVariable | Yes | Literal destination variable name, e.g. skill.result |
| message | For new jobs | Question, e.g. ${system.message.messagePayload.text} |
| options | No | Map / JSON object with the optional settings below |

ODA controls display order, so this version reduces the field count rather than promising a particular order.

Use this connection object, replacing the password locally:

```json
{
  "baseUrl": "https://fa-yourpod-saasfademo1.ds-fa.oraclepdemos.com",
  "username": "YOUR_FUSION_USERNAME",
  "password": "YOUR_FUSION_PASSWORD"
}
```

The metadata declares connection and options as Map properties. You can supply a JSON
object in the editor, or a FreeMarker expression resolving to a Map variable, e.g.
`${skill.fusionConnection}`. The input parser also accepts JSON text if your editor
passes it as a string. Actual acceptance of that textual form depends on ODA's Map
property validation; use a Map variable if necessary.

Leave options empty for the basic demo. Example options:

```json
{
  "parameters": { "id": 42 },
  "conversationId": "previous-conversation-id",
  "waitSeconds": 15
}
```

Supported options:

* parameters: workflow-specific JSON object, default {}. A JSON object string is also accepted.
* conversationId: previous result's conversation ID, retained per user for follow-up questions.
* jobId: resume an existing job; no new workflow is started.
* waitSeconds: polling window after the initial response, default 15, allowed 0-20.
* scope: explicit override if automatic derivation does not match your environment.

Scope may also be set in connection; options.scope takes precedence. Known URL patterns:

```text
fa-yourpod-saasfademo1.ds-fa.oraclepdemos.com -> urn:opc:resource:fusion:yourpod:fusion-ai/
mypod-test.fa.em2.oraclecloud.com             -> urn:opc:resource:fusion:mypod-test:fusion-ai/
```

Unknown hostname formats require an explicit scope. baseUrl must be the HTTPS origin,
without /hcmUI/redwoodAI or another path. Configure connection once in a skill Map or
reusable configuration rather than taking credentials or the base URL from chat text.

## Outputs and transitions

Create a skill-level Map named result. Set resultVariable to the literal text `skill.result`,
not `${skill.result}`. The property specifies the destination name, not its current value.

On success:

```json
{
  "output": "TEST OK",
  "status": "COMPLETE",
  "jobId": "job-id",
  "conversationId": "conversation-id",
  "workflow": "DEMO_WORKFLOW"
}
```

Display `${skill.result.output}`. callAgent does not expose a token.

On pending, the Map has output null and the current status/jobId/conversationId. Copy the
IDs into separate variables, then call again with options.jobId (and optionally
options.conversationId). The result Map is cleared on entry; do not depend on it retaining
old IDs after entry. Bound the polling loop, e.g. three extra calls, then show a pending
message. Leave options.jobId empty for every new question.

On failure:

```json
{"error":{"code":"HTTP_ERROR","message":"Fusion returned HTTP 403.","httpStatus":403,"stage":"fusion-call"}}
```

Display `${skill.result.error.message}`. There is no separate errorVariable.

## getToken: two fields

* connection: the same Map as callAgent (include scope here if you need an override).
* resultVariable: literal Map variable name, e.g. skill.tokenResult.

On success the result contains token (without the Bearer prefix), expiresAt (UTC ISO
string or null), and scope. For your own REST requests use Authorization: Bearer plus
the token. Do not display this result Map in a chat response. Failure uses the same
error shape as callAgent. getToken is optional: callAgent handles tokens itself.

## Cache and request lifecycle

Both components share the same worker-local memory cache, isolated by base URL, scope,
username and password. Changing workflow or conversation does not prevent reuse.
Tokens are renewed up to 60 seconds before expiry (10% margin for short-lived tokens).
Concurrent calls share acquisition. Cache size is bounded; a token without a readable
JWT expiry is usable but not cached. JWT decoding schedules renewal; Fusion verifies
signatures. Tokens are not saved to files.

An HTTP 401 causes callAgent to renew and retry that request once. A worker restart or
another ODA worker causes automatic token acquisition. The overall call deadline is
25 seconds; individual requests have at most 10 seconds. A timeout after submitting a
job can leave it running even if its ID was not received; network errors are not blindly
retried. Long-running jobs use pending and options.jobId.

## Diagnostics and local checks

Enable Component Logging, reproduce a failure, then use Diagnostics -> View Logs.
Logs show operation, runtime version, stage, error code and status, never credentials,
tokens or response bodies. With no start message, check Diagnostics -> View Crash Report.

Runtime: Node.js 18 or newer. No runtime npm dependencies.

```powershell
node -e "require('./test/fusion.test.js'); require('./test/interface.test.js'); require('./test/inputs.test.js')"
npm pack --ignore-scripts
```

Local tests cover grouped Map/JSON inputs, option isolation, output transitions, scope
derivation, token reuse/renewal/concurrency/isolation, 401 retry, polling, Unicode and
failure diagnostics. After installing in your own ODA environment, verify the connection and workflow with your configuration.

Oracle references:

* https://docs.oracle.com/en/cloud/saas/fusion-service/famsr/upload-resolved-service-requests.html
* https://docs.oracle.com/en/cloud/saas/sales/faaps/op-actionplans-action-getprocessaccesstoken-post.html
* https://docs.oracle.com/en-us/iaas/digital-assistant/doc/implement-custom-components.html

## Related example

[OCI Enterprise AI to Fusion through MCP](https://github.com/mdijkens-oracle/oci-eai-fusion-mcp)
shows the separate EAI integration route.

## License

This project is licensed under the [MIT License](LICENSE).
Copyright (c) 2026 M. Dijkens.


