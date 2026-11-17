# Gmail OAuth connection

Hearth can send Gmail messages without an app password. In **Mail → Accounts → Connect Gmail**, configure a Google OAuth client and connect your account. Chat email cards and their editable fields use the same approval and effect ledger as other mail accounts.

## One-time setup

1. Create a Google Cloud project and enable the Gmail API.
2. Configure Google Auth Platform branding and audience. For an external application in testing, add your Gmail address as a test user.
3. Create a **Web application** OAuth client.
4. Register the exact redirect URI displayed in Hearth, normally `http://127.0.0.1:4317/api/mail/gmail/callback`. Use the same hostname for the Hearth page and callback: do not mix `localhost` and `127.0.0.1`.
5. Enter the client ID and client secret in Hearth, then click **Connect Google account**. Secrets are stored encrypted locally and never returned by the settings API.
6. Authorize the account. Hearth asks for `openid`, `email`, and `gmail.send`; it does not request inbox access.
7. Return to the chat email card, select the Google account, edit the recipient and message, and click the airplane. Review and approve the actual message before sending.

Existing SMTP accounts are preserved. Choose the newly connected Google account instead of the old SMTP account that failed authentication. OAuth accounts do not support IMAP sync. Testing authorization refreshes the token without sending mail.

## Lifecycle and troubleshooting

- External apps in testing may receive refresh tokens that expire after seven days. Reconnect when authorization expires. Workspace administrators can restrict third-party apps.
- If the OAuth client changes, reconnect accounts using that client.
- State is single-use, expires after ten minutes, and is bound to an HttpOnly SameSite cookie. The callback also uses PKCE. A server restart during login requires starting login again.
- Account and client secrets are encrypted with the existing local master key. Keep that key when moving the local database.
- Removing an account deletes local authorization records. To revoke access at Google, remove Hearth's application under Google Account → Third-party connections.
- Mail delivery is never automatically retried after an uncertain response. Check Gmail's Sent folder and Hearth's sending record before attempting another send.
- This implementation supports local HTTP loopback callbacks. Public deployment requires an HTTPS callback and an appropriate Google OAuth publishing/verification setup.

References: [OAuth web server flow](https://developers.google.com/identity/protocols/oauth2/web-server), [Gmail sending](https://developers.google.com/workspace/gmail/api/guides/sending).
