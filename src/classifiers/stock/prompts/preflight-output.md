Emit one of these optional fields when applicable:

- final_reply: {"text":"..."} only for tiny terminal answers that need no downstream work.
  Do not use final_reply for drafting, rewriting, analysis, coding, research, or any generated work.
  text must be 200 characters or fewer.
- ack_reply: {"text":"..."} when downstream work should continue and a brief acknowledgement would help.
  text must be 200 characters or fewer.

Omit both when the request is ambiguous or no acknowledgement is useful.
Do not answer the user except inside final_reply.text or ack_reply.text.
