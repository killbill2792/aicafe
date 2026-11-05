## 4. The Operating Board, inbox and proactive reports
**Operating Board** = the status board at the top of the Supervisor chat (`components/home/ChatStart.tsx`).
It is the owner's single place to see:
1. Key numbers for the chosen period (sales, known costs, kept), with partial/estimate labels.
2. **Needs attention**: items from the shared attention list.
3. **Running**: every active experiment or monitor, with what is being watched, day X of Y, and the
   latest early read.
4. **Recent reports**: finished experiments and proactive findings, each linking to its chat thread.
The board reads the same data as the AI's tools. Never give the board its own query.

**Inbox and notifications.** Every proactive finding, experiment update and final report becomes an
inbox item (`operating_tasks`) and a short chat message in the related thread. The owner sees an
unread count on the board.
- **Channels:** in-app inbox and notification badge now. Email next. Browser push after that.
  WhatsApp/SMS only after a verified business sender exists.
- **Not noisy:** no duplicate alerts for the same finding, a daily cap per café, and the owner can mute
  a type. Every notification says what happened, why it matters (with the number) and the next step.

**Proactive monitors** are scheduled jobs (`app/api/cron/*`). They read the same readers and calculators
as the chat, write inbox items, and post a short report into chat. They never change data owned by
the owner or the POS. They run daily, plus live checks every ~30 minutes while the café is open for
urgent issues (nobody clocked in for a shift, sales far below normal, an item running out, an unusual
void or refund).
