# Notifications structure

- `index.ts`: pi entry; re-exports the default from `api/extension.ts`.
- `api/extension.ts`: `createManagedExtension` with namespace `pi-notifications`, `notificationsPlugin` and the `pi-notifications.json` settings.
- `api/plugin.ts`: `notificationsPlugin`; host hooks, busy and awaiting-input subscriptions, key listener and `terminalNotify` wiring.
- `core/notifications.ts`: `createNotifier`; idle and wait timers, open waits, busy sources and the notification texts (a wait timer only fires with a wait open).
- `core/settings.ts`: `NotificationSettings`, `defaults`, `schema`, `SETTINGS_FILE`.
- `tests/notifications.test.ts`: the extension booted on a fake host with real settings files in a temp dir.
