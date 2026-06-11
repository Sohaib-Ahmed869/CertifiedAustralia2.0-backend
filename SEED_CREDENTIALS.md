# Seed User Credentials

Run `node src/seed-users.js` from the backend directory to create these users.

| Role                 | Email                | Password       | Name             |
|----------------------|----------------------|----------------|------------------|
| Admin                | admin@yopmail.com    | Admin@1234     | Sarah Mitchell   |
| CEOReportingManager  | ceo@yopmail.com      | Ceo@1234       | James Thompson   |
| Agent                | agent@yopmail.com    | Agent@1234     | Michael Chen     |
| InternalRTO          | rto@yopmail.com      | Rto@1234       | Emily Davis      |
| Support              | support@yopmail.com  | Support@1234   | David Wilson     |

All users are created with **MFA enabled** (TOTP via authenticator app). On first login, you will be prompted for a 6-digit code. To set up your authenticator, navigate to Security (MFA) in the portal sidebar after logging in, or disable MFA temporarily via the database.

> The script skips any user whose email already exists, so it's safe to re-run. If users were created before MFA was added, delete them from the database and re-run.
