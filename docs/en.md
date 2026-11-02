# UBPet Litter Box

Control UBPet / UPET self-cleaning litter boxes (UBPet C20, C10, C10 Pro and the other boxes of the UPET app, including Meowant and Airrobo rebrands) from Gladys Assistant.

The integration talks to the same cloud as the official UPET app. Box state and new visits arrive in real time over the vendor's live connection; the waste bin, deodorant and visit history are refreshed every few minutes.

## What you get

One Gladys device per litter box, with:

| Feature                 | What it does                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------- |
| Cleaning                | Switch: on starts (or resumes) a cleaning cycle, off pauses it. Shows whether one runs. |
| Levelling               | Switch: same for levelling the litter.                                                  |
| Command                 | Clean now, Level the litter, Pause, Resume, Waste bin emptied, Refresh state.           |
| Status                  | Idle, Cleaning, Levelling, paused, blocked, Offline...                                  |
| Cat inside              | Live: 1 while a cat is in the box.                                                      |
| Waste bin level         | Fill level in %.                                                                        |
| Uses since bin emptied  | Counter, reset with the "Waste bin emptied" command.                                    |
| Visits in the last 24 h | From the visit history.                                                                 |
| Last visit, duration    | E.g. "Milo · 4.3 kg · 52 s".                                                            |
| Deodorant remaining     | Days left.                                                                              |
| Auto clean after use    | Switch, and its delay in minutes (1 to 60).                                             |

Scene triggers: **A cat used the litter box** (filter by box and cat name; gives the cat, weight and duration to the scene), **Waste bin is full**, **Litter box is blocked**.

**Safety:** the integration refuses to start or resume a movement when the box reports a cat inside or near it, or when it cannot read the box state. The box keeps its own weight and infrared protections on top of that.

## Prerequisites

- Gladys Assistant 5.1 or later.
- The box set up in the **UPET** app, with an Internet connection.
- **A second UPET account (strongly recommended).** The UPET cloud allows one session per account: if Gladys and your phone use the same account, they keep logging each other out. Create a second account in the UPET app, then from your main account share the litter box with it (device settings, share). Use the second account in Gladys.

## Configuration

1. **App edition / region**: the UPET app edition the account was created in. In Europe (Switzerland included) this is **UPET - Europe**. North American accounts use UPET-NA, Japanese and Korean accounts UPET-ASIA. Choosing the wrong one gives "Unknown account on this server".
2. **Country code**: the country chosen in the app, as two letters (CH, DE, FR...). Optional for most accounts; required for some (Russian accounts in particular).
3. **UPET account** and **password** of the second account.
4. Save, then press **Test the connection**: it lists the boxes found and says whether the live link is up.
5. Open the **Discovery** tab and create the litter box.

Leave the **Advanced** fields empty. They exist only in case the vendor changes the app identity.

## Troubleshooting

- **"Login refused: Wrong account or password"**: check the credentials in the UPET app. The integration does not retry a refused password on its own (repeated refusals can lock the account); saving the configuration retries.
- **"Unknown account on this server"**: wrong region, see step 1.
- **"Another login on this UPET account took the session"**: Gladys and the phone share an account. Use a second account.
- **Status "Unknown" and commands refused with "Box state unknown"**: the live link is down (an orange dot on the device's cloud badge). It reconnects by itself, backing off up to 30 minutes if another login keeps taking the session.
- **The box is busy**: a command cannot start a cleaning while the box levels the litter, for instance. Pause or wait for the current job.

This is a community integration, not affiliated with UBTECH / UPET. It relies on the vendor's private API, reverse-engineered by the Home Assistant community, which can change without notice.
