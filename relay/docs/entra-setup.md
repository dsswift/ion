# Azure AD (Entra) Setup for Ion Relay

This guide configures Azure AD (Entra ID) as the OIDC provider for Ion
Relay. Complete these steps once per department. Each department gets its
own app registration, relay URL, and set of users.

---

## Step 1: Create the Relay API App Registration

1. In the Azure portal, go to **Azure Active Directory → App registrations
   → New registration**.
2. Name it for your department — for example, `Ion Relay - Engineering`.
3. Set **Supported account types** to *Accounts in this organizational
   directory only* (single tenant).
4. Leave **Redirect URI** blank (the relay is not a browser app).
5. Click **Register**.

**Expose an API and add a scope**

6. In the new app registration, go to **Expose an API**.
7. Click **Set** next to **Application ID URI**. Accept the default
   (`api://<application-id>`) or set a custom URI. Note this value — it
   becomes `RELAY_OIDC_AUDIENCE`.
8. Click **Add a scope**:
   - Scope name: `Relay.Access`
   - Who can consent: *Admins and users*
   - Admin consent display name: `Access Ion Relay`
   - Admin consent description: `Allows the Ion desktop app to connect to
     the Ion Relay WebSocket service.`
   - State: *Enabled*
9. Click **Add scope**.

---

## Step 2: Configure the Enterprise Application

Every app registration has a corresponding enterprise application. Configure
it to require assignment so only provisioned users can obtain tokens.

1. In **Azure Active Directory → Enterprise applications**, find the app
   with the same name you used in Step 1.
2. Go to **Properties** and set **Assignment required** to **Yes**. Save.
3. Go to **Users and groups → Add user/group**.
4. Add the department members or security group that should have relay
   access.

Users not listed here will receive an authorization error when they attempt
to obtain a token, even if they have valid Azure AD credentials.

---

## Step 3: Register the Ion Client App Permission

The Ion desktop app needs permission to request tokens scoped to the relay
API. If your organization has a separate app registration for the Ion desktop
client, add the permission there. If not, create a new app registration for
the Ion client.

1. In the Ion client app registration, go to **API permissions → Add a
   permission**.
2. Select **My APIs** and choose the relay app registration you created in
   Step 1 (`Ion Relay - Engineering`).
3. Select **Delegated permissions** and check `Relay.Access`.
4. Click **Add permissions**.

---

## Step 4: Grant Admin Consent

Delegated permissions require admin consent before users can authorize them.

1. In the Ion client app's **API permissions** blade, click **Grant admin
   consent for {your tenant}**.
2. Confirm. The status column should show green checkmarks.

---

## Step 5: Configure the Relay

Set these environment variables on the relay container:

```bash
RELAY_OIDC_ISSUER=https://login.microsoftonline.com/{tenant-id}/v2.0
RELAY_OIDC_AUDIENCE=api://<relay-app-id>
RELAY_OIDC_REQUIRED_SCOPE=Relay.Access
```

Replace `{tenant-id}` with your Azure AD tenant ID (a UUID, visible in
**Azure Active Directory → Overview**) and `<relay-app-id>` with the
Application (client) ID of the relay app registration from Step 1.

The relay fetches JWKS automatically from
`https://login.microsoftonline.com/{tenant-id}/v2.0/.well-known/openid-configuration`.
No manual key configuration is needed.

---

## Step 6: Per-Department Topology

Repeat Steps 1 through 5 for each department. Each department gets:

- Its own app registration (e.g., `Ion Relay - Finance`, `Ion Relay - Legal`)
- Its own Application ID URI (`api://<dept-app-id>`)
- Its own relay deployment with its own `RELAY_OIDC_AUDIENCE`
- Its own user group assignment

This ensures that a token issued for the Engineering relay cannot be used
against the Finance relay, even if both tokens are technically valid JWTs
from the same tenant.

---

## Other OIDC Providers

The relay is provider-agnostic. It validates tokens using standard
OIDC discovery and JWKS. The same pattern works with any compliant provider:

| Provider | Issuer URL pattern | Notes |
|---|---|---|
| Okta | `https://{domain}/oauth2/default` or a custom authorization server URL | Add the relay audience as an authorized API in Okta. |
| Auth0 | `https://{domain}/` | Create an API resource in Auth0; set the identifier as the audience. |
| Keycloak | `https://{host}/realms/{realm}` | Create a client with client credentials or authorization code flow; set the audience mapper on the token. |

For all providers: set `RELAY_OIDC_ISSUER` to the issuer URL, `RELAY_OIDC_AUDIENCE`
to the audience identifier the tokens carry, and `RELAY_OIDC_REQUIRED_SCOPE`
to whatever scope name the provider issues for relay access.
