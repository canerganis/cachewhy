# Security

cachewhy reads local agent logs, which can contain sensitive work. It is designed so that nothing leaves the machine: no runtime dependencies, no network calls, and no message text in any report.

If you find a way cachewhy could leak log content, paths or ids (in its output, its JSON, an error message or the npm package), please report it privately through GitHub's "Report a vulnerability" button on the Security tab instead of opening a public issue. Do not attach real logs; describe the shape of the record instead.
