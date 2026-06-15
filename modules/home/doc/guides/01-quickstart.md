# Quickstart

This guide gets you from zero to your first authenticated API call in a few minutes.

## 1. Get an API key

Sign in to your account and create an API key from the developer settings. Treat the key like a password — store it in an environment variable, never commit it to source control.

```bash
export API_KEY="<YOUR_API_KEY>"
```

## 2. Make your first request

Send the key as a Bearer token in the `Authorization` header. Replace the host with your deployment's API base URL.

```bash
curl https://api.example.com/api/tasks \
  -H "Authorization: Bearer $API_KEY"
```

## 3. Read the response

Every endpoint returns a standard JSON envelope. A successful response wraps the payload in a `data` field:

```json
{
  "type": "success",
  "message": "task list",
  "data": []
}
```

An error response uses the same shape with `"type": "error"` and an HTTP status code in `status`. Check `type` first, then read `data` (on success) or `description` (on error).

## Next steps

You now have a working request. Explore the rest of the reference to discover the available endpoints and their parameters.
