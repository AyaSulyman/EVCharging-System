# Judge Q&A Handbook — 50 questions

**Rule for all three of you: if we did not build it, say so.** This handbook lists what is
deliberately not built (Q41–50). A confident "we did not build that, and here is why" scores better
than a vague answer that falls apart on the follow-up.

**Who answers what:** Malik — rules, optimizer, business. Abdel Aziz — database, back end, operator
side, what each feature does. **Aya — screens, customer journey, page rendering (Q38–40), analytics.**

---

## A. The core guarantee (1–8)

**1. What stops two people booking the same charger at the same time?**
The database, not our code. We split charger time into 15-minute blocks and told the database that
one block can have only one owner. The second booking gets a duplicate-key error. We tested it: two
overlapping bookings, the second is refused.

**2. Why not just check for clashes in your code before saving?**
We did that first. Two problems. A check in code can be skipped by a feature written later, and if
two requests arrive at the same instant both can pass the check before either saves. A database
constraint has neither problem.

**3. Why 15 minutes?**
It divides evenly into every length we support — 15, 30, 45, 60, 90, 120. No rounding, no wasted
time. One-minute blocks would multiply database writes by fifteen for precision nothing needs.

**4. What is the cost of that design?**
Bookings must start on the quarter hour. You cannot book 15:07. Arbitrary *length* is fully
supported; arbitrary *start time* is not. We accepted that trade knowingly.

**5. Can two bookings sit back to back?**
Yes, and this is the check we care most about. A booking ending at 16:00 does not own the block
starting at 16:00. We got this backwards once and it made every adjacent pair unbookable — which is
why it is now an automatic test.

**6. What if the app crashes halfway through a booking?**
We write the booking first and claim the time second. So a crash leaves a booking holding nothing —
which our repair tool detects — rather than time held by nothing, which no query can see and no
driver can book. We chose which way it breaks.

**7. How do you know that repair tool works?**
`npm run ops:reconcile` checks both directions and currently reports zero problems. We found during
an audit that it only checked the old model and not the current one, and fixed that.

**8. Is any of this actually tested, or do you just believe it?**
182 automatic checks run against a real database every time we change anything. They include the
overlap test, the back-to-back test, and the held-charger test.

---

## B. The optimizer (9–18)

**9. Is this artificial intelligence?**
No. It is a fixed set of rules with fixed weights. The same inputs always give the same answer. We
chose that deliberately — a manager needs to be able to explain a decision to a customer.

**10. Then why call it an optimizer?**
Because it solves a real scheduling problem: many people wanting overlapping times on limited
chargers. Choosing the best slot for one person repeatedly does not solve it — two people scored
separately will happily be given the same charger.

**11. What does it actually score?**
Five things: how well a slot keeps free time in usable blocks, how close it is to the time requested,
how long the person has waited, their priority, and how likely they are to turn up.

**12. How do you know it is better than first-come-first-served?**
Every run also calculates what first-come-first-served would have achieved on the same data, and
stores both numbers. If we are not better, the record says so.

**13. Why does it place the most constrained person first?**
If someone can only come at 15:00 and someone else will take any time today, serving the flexible
person first can consume the only slot the rigid person could have used — and then we serve one
person instead of two. Constraining first serves more people.

**14. Does a low reliability score stop someone booking?**
No. It only affects who gets the better slot when two people want the same one. A system that could
lock someone out would be a ban dressed up as an optimisation.

**15. Does reliability affect queue position?**
No, and that was deliberate. Waiting time and priority sit outside the reliability calculation, so
an unreliable customer is reordered but never starved of service entirely.

**16. How long does a pass take?**
Milliseconds on our data, and it has a hard time limit so a booking screen never waits on it.

**17. What if the optimizer is wrong?**
An operator can run it in preview mode, see the whole plan and the reasoning, and decide not to apply
it. They can also make an offer manually.

**18. Can it move an existing booking?**
Only within the flexibility that driver explicitly agreed to. If they said "strict", nothing moves
them.

---

## C. Waitlists and offers (19–25)

**19. What happens if nothing is free?**
The request is waitlisted. It keeps its place and is reconsidered automatically every time a charger
frees up.

**20. What is the five-minute hold?**
When we offer someone a charger, we really hold it — nobody else can book it for five minutes. That
is what makes accepting safe: the charger was already secured when the offer was made.

**21. Why five minutes and not longer?**
A held charger is frozen stock. If the offer is ignored, that time was wasted. Five minutes is long
enough to read a notification and answer, short enough that ignored offers cost very little.

**22. Why the same five minutes for a two-hour booking?**
Because the hold should scale with the number of decisions pending, not the length of the booking. If
it scaled with length, the most valuable bookings would be the most expensive to offer.

**23. What if someone accepts after it expires?**
They get a new offer, not an error. The system runs again and finds them another time. Being slow
should not throw you out of the queue.

**24. Does the system offer the same person three chargers at once?**
No — one live offer per person. Each extra offer would freeze another charger against the same single
decision.

**25. Does an ignored offer loop forever?**
No. After three unanswered offers the system stops volunteering. The request stays live and can still
be fulfilled by hand or by an operator.

---

## D. Deposits and money (26–31)

**26. Are payments real?**
No. Payments are simulated. No card number, expiry, CVC or token is ever accepted, stored,
transmitted or displayed. There is no field for one.

**27. Then what is real about it?**
The rules and the records. Every deposit, refund and forfeiture is recorded with its reason, and the
refund rules are enforced in one place used by every path.

**28. What are the refund rules?**
More than 24 hours ahead — full refund. Less than 24 hours, or a no-show — deposit kept. Anything
that was our fault — full refund.

**29. What counts as your fault?**
A technical incident, a charger failure, maintenance, a knock-on delay, or us rescheduling the
booking. In all of those the driver is refunded and their reliability is untouched.

**30. Could a driver claim it was your fault to get a refund?**
No. Only staff or an admin can mark something as operator fault. If a driver could set it, they would
refund themselves every time.

**31. How hard is real payment integration?**
The connection point already exists, along with the payment-intent and refund records and the
protection against double-charging. It is a swap, not a rebuild.

---

## E. Reliability and behaviour (32–36)

**32. How is the score calculated?**
Everyone starts at 100. Turning up adds a point. A late arrival, a late cancellation or a no-show
subtract. It is recalculated from the recorded history each time.

**33. Why not just keep a running total?**
Because a running total drifts. Miss one update or apply one twice and the number is wrong forever
with no way to tell. Recalculating means a repeated event cannot double-count and a lost one repairs
itself.

**34. Is a score alone enough to judge someone?**
No, which is why we also show the pattern behind it — how late, how often, how much notice they give
when cancelling. An operator sees the reason, not just the number.

**35. Is it fair to penalise someone for a fault that was yours?**
No, and we do not. Fault is recorded on the event at the moment it happens, so a scorer can never
accidentally penalise a driver for our charger failing.

**36. Do the demo scores actually vary?**
Yes — 100, 83, 0 and 0 across four drivers with genuinely different behaviour. We can show the
underlying no-show and late counts.

---

## F. Technical implementation (37–44)

> **Q38–40 are rendering — Aya answers these.** The rest of this section is Abdel Aziz.

**37. Why MongoDB?**
Honestly, it is what the team knew. A relational database with an exclusion constraint would express
the overlap rule more directly. We got the same guarantee by splitting time into blocks.

**38. Why Next.js for both apps?**
One framework, one language across the whole project, and it gives us a choice of rendering mode per
page rather than one for everything.

**39. Which pages are server-rendered and why?**
Public pages — home, stations, station detail — so a driver and a search engine both see real
availability in the first response. The QR landing page is server-rendered and never cached, because
showing a bay as free when it was taken thirty seconds ago is the failure we exist to prevent.

**40. Which are static, and which run in the browser?**
Static: about, FAQ, terms, privacy — same for everyone, rarely change. Browser-rendered: the driver's
own area and the booking wizard, because they need the login token and a lot of interaction.

**41. How do notifications work?**
They are produced by a separate process that reads the record of what happened. Nothing in the
booking flow creates one. A driver cancelling must never fail because a message could not be written.

**42. What stops duplicate notifications?**
A uniqueness rule in the database. If the same event is processed twice, the second insert is rejected
rather than producing a second message.

**43. What runs in the background?**
Deposits expiring, no-show detection, overstay detection, delay recalculation, re-planning freed
capacity, and notifications. One command runs all of them.

**44. What happens if those jobs stop?**
Nothing becomes incorrect — bookings and the double-booking guarantee are unaffected. But holds stop
expiring, no-shows are not detected and freed time is not re-offered. It degrades, it does not break.

---

## G. Scope, honesty and limits (45–50)

**45. What is not built?**
Real card payments. Email and SMS delivery — messages are in-app only. A real check-out signal. Extra
time reserved automatically for overstays. Per-station tuning of the scoring weights. Bookings
spanning two separate free periods.

**46. What is the weakest part of the system?**
We assume a driver leaves when charging stops. If they unplug and leave the car parked, we resell a
bay that is still physically occupied. A sensor or a second scan would fix it; we did not have that.

**47. Did you find bugs in your own work?**
Several, and by running the system rather than reading it. One example: our waitlist success rate
read zero even though a driver really had been waitlisted and then served — because the field we were
reading is cleared the moment we make an offer. Every success was erasing its own evidence.

**48. How did you catch that?**
We wrote a check that runs the real thing and asserts what the dashboard should show. It failed, and
that is how we found it. We now write that kind of check whenever two parts of the system have to
agree about the same fact.

**49. What would you do differently?**
Write the verification alongside the feature rather than after it. Every one of our 182 checks passed
while half the dashboard showed no data — the logic was right and nothing had ever fed it. Testing the
logic and testing the wiring are different jobs.

**50. Is this ready for a real station?**
The reservation core is — the double-booking guarantee is enforced by the database and tested. Before
real customers we would need real payments, real message delivery, and a check-out signal. We would
not claim more than that.
