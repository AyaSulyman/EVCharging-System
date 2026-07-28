# ChargeHub — Executive Summary

**A reservation system for electric vehicle charging stations.**
Malik Halimeh · Abdel Aziz · Aya Sulyman

---

### The problem

A charging station is a shop with very few seats. Charging takes 15 minutes to 2 hours and a station
has only a handful of chargers, so every wasted slot is a customer turned away. Four things go wrong:
two drivers book the same charger, chargers sit empty after cancellations, people never turn up, and
staff end up scheduling by hand under pressure.

### What we built

A working platform with three users — driver, station operator, manager — covering the full journey:
book a charger for any length from 15 to 120 minutes, hold it with a small deposit, arrive and check
in with a QR code, charge, and leave. Around that sit the parts that make a station efficient rather
than merely bookable: a scheduler that decides who gets which charger, a waitlist that offers freed
time automatically, extensions checked against real capacity, reliability scores built from real
behaviour, incident and delay handling, and 31 measurements on a manager's dashboard.

### The core guarantee

**Two drivers can never be sold the same charger — and that is enforced by the database, not by our
code.** Charger time is split into 15-minute blocks, and the database allows one owner per block.
A check written in application code can be bypassed by a feature added later, and two simultaneous
requests can both pass it. A database constraint has neither weakness. This is tested: overlapping
bookings are refused, back-to-back bookings are accepted.

### What makes it more than a booking form

- **It plans, and explains itself.** The scheduler scores every possible slot on five factors and
  stores the reason for its choice, so a customer asking "why 4:30 and not 3:00?" gets a real answer.
  It is deterministic — not AI — so the same situation always produces the same decision.
- **It proves it helps.** Every scheduling run also calculates what plain first-come-first-served
  would have achieved on identical data. The claim is measured, not asserted.
- **Freed time is resold.** A driver leaving early returns their unused minutes to the market within
  a minute, offered first to someone already charging who wanted more time, then to the waiting queue.
- **It is fair by design.** Waiting longer helps you. A poor reliability score never blocks a booking
  — it only breaks ties — so no customer can be locked out by their own history.

### Evidence

| | |
|---|---|
| Automatic checks passing | **182** |
| Demo-readiness checks passing | **16** |
| Measurements on the manager dashboard | **31** |
| Repeatable demo scenarios | **10** |
| Database collections | **14** |
| API endpoints | **53** |
| Double bookings possible | **0** |

### Honest limits

Payments are **simulated** — no card data is accepted, stored or displayed anywhere; the records and
refund rules are real. Notifications are **in-app only**. And we assume a driver leaves when charging
stops, so a car left plugged in after the session ends is invisible to us — a sensor or second scan
would close that gap. These are named, not hidden.

### What we learned

The lesson that cost us the most was that **testing the logic is not the same as testing the wiring**.
At one point all 182 checks were passing while half the dashboard showed no data: every rule was
correct and nothing had ever fed it. We now write a check that would fail if two individually-correct
parts disagreed with each other — a habit that found four real defects that reading the code had
missed.
