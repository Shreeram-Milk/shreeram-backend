-- 0017: how an online payment was made, for staff.
--
-- PhonePe reports the method (UPI, card, net banking), the instrument (debit card, credit card, bank account), the bank,
-- and the bank's own reference (the UTR for UPI, the bank reference number for cards and net banking). Staff need these to
-- answer "how did this customer pay?" and to match a payment with a bank statement. Card numbers and UPI ids are never stored.
-- Only adds columns; existing rows keep NULL until filled.

BEGIN;

ALTER TABLE payments
  -- PhonePe's payment mode, for example UPI_INTENT, UPI_COLLECT, UPI_QR, CARD, NET_BANKING.
  ADD COLUMN IF NOT EXISTS payment_mode text CHECK (payment_mode IS NULL OR length(payment_mode) <= 40),
  -- The instrument PhonePe reports, for example DEBIT_CARD, CREDIT_CARD, NET_BANKING, ACCOUNT.
  ADD COLUMN IF NOT EXISTS payment_instrument text CHECK (payment_instrument IS NULL OR length(payment_instrument) <= 40),
  -- The bank's name, when PhonePe gives it.
  ADD COLUMN IF NOT EXISTS payment_bank text CHECK (payment_bank IS NULL OR length(payment_bank) <= 100),
  -- The bank's reference for the money movement: UTR (UPI) or bank reference number (cards, net banking).
  ADD COLUMN IF NOT EXISTS bank_reference text CHECK (bank_reference IS NULL OR length(bank_reference) <= 100);

COMMIT;
