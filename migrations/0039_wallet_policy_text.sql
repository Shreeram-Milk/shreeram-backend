-- 0039: wallet wording in the Privacy, Terms and Refund policies. Run as shreeram_migrate, in one go, in pgAdmin.
-- Wrapped in BEGIN/COMMIT: either all three are updated or none is. If pgAdmin shows an error, run `ROLLBACK;` once and send me the error.
--
-- How it works: a published policy can never be edited, so for each of the three it
--   1. takes the version that is published now,
--   2. publishes a NEW version (1.0 -> 1.1, 1.1 -> 1.2 ...) with exactly the same text plus a wallet section,
--      placed just before the last line ("If the English and Gujarati versions differ..."),
--   3. moves the old version to the archive (kept for the record, as the law expects).
-- Running it a second time changes nothing: a policy that already mentions the wallet is skipped.
-- The app and website show the new versions within a minute.

BEGIN;

-- Puts `addition` just before the last paragraph of `body`. A temporary helper: it disappears when pgAdmin's connection closes.
CREATE FUNCTION pg_temp.wallet_inserted(body text, addition text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN strpos(reverse(body), E'

') = 0 THEN body || E'

' || addition
              ELSE left(body, length(body) - strpos(reverse(body), E'

') - 1) || E'

' || addition
                   || substr(body, length(body) - strpos(reverse(body), E'

')) END
$f$;

DO $$
DECLARE
  section record;
  current_row record;
  new_version text;
BEGIN
  FOR section IN
    SELECT * FROM (VALUES
      ('privacy',
       E'ShreeRam Wallet\nIf you use the wallet, we keep your wallet balance, every wallet transaction (money added, orders paid from the wallet, money returned to it) and any refund request with its PhonePe reference and dates. We use this only to run the wallet, send refunds and keep the payment records the law requires. Money is added through PhonePe: we never see or store your card, UPI or bank details. Wallet records are kept like our other payment records, also after you delete your account, but without your name or contact details.',
       E'ShreeRam વૉલેટ\nજો તમે વૉલેટ વાપરો, તો અમે તમારું વૉલેટ બેલેન્સ, વૉલેટની દરેક લેવડદેવડ (ઉમેરેલા પૈસા, વૉલેટથી ચૂકવેલા ઓર્ડર, વૉલેટમાં પાછા આવેલા પૈસા) અને દરેક રિફંડ વિનંતી તેના PhonePe નંબર અને તારીખો સાથે રાખીએ છીએ. આનો ઉપયોગ ફક્ત વૉલેટ ચલાવવા, રિફંડ મોકલવા અને કાયદા મુજબ જરૂરી ચુકવણીના રેકોર્ડ રાખવા માટે થાય છે. પૈસા PhonePe દ્વારા ઉમેરાય છે: અમે તમારા કાર્ડ, UPI કે બેંકની વિગતો ક્યારેય જોતા કે રાખતા નથી. વૉલેટના રેકોર્ડ અમારા બીજા ચુકવણી રેકોર્ડની જેમ રહે છે, ખાતું ડિલીટ કર્યા પછી પણ, પણ તમારા નામ કે સંપર્ક વિગતો વિના.'),
      ('terms',
       E'ShreeRam Wallet\n- Money in the wallet can only be spent on ShreeRam Milks orders. It cannot be sent to another person, cannot be withdrawn as cash, and earns no interest.\n- You can add at least ₹100 at a time, and the wallet can hold up to ₹10,000.\n- Money is added only after PhonePe confirms the payment.\n- The balance does not expire.\n- Pay-later (credit) accounts cannot add money to the wallet.\n- Please ask for a refund of any balance before you delete your account.',
       E'ShreeRam વૉલેટ\n- વૉલેટના પૈસા ફક્ત ShreeRam Milks ના ઓર્ડરમાં વાપરી શકાય. તે બીજા કોઈને મોકલી શકાતા નથી, રોકડા ઉપાડી શકાતા નથી, અને તેના પર વ્યાજ મળતું નથી.\n- એક વખતમાં ઓછામાં ઓછા ₹100 ઉમેરી શકાય, અને વૉલેટમાં વધુમાં વધુ ₹10,000 રહી શકે.\n- PhonePe ચુકવણી પાકી કરે પછી જ પૈસા ઉમેરાય છે.\n- બેલેન્સની કોઈ સમયમર્યાદા નથી.\n- પછી ચૂકવનાર (ક્રેડિટ) ખાતામાં વૉલેટમાં પૈસા ઉમેરી શકાતા નથી.\n- ખાતું ડિલીટ કરતાં પહેલાં બાકી બેલેન્સનું રિફંડ માંગી લેશો.'),
      ('refund',
       E'Wallet refunds\n- If an order you paid from the wallet is cancelled, the money goes back to your wallet straight away.\n- For a missed delivery paid from the wallet, we look at each case and return the money to your wallet.\n- You can ask for your whole wallet balance back from the Wallet screen. It goes back to the PhonePe payments you added it with and usually reaches you in 7–10 working days.\n- Only one refund request can be open at a time. While it is on its way, that money cannot be spent.',
       E'વૉલેટ રિફંડ\n- વૉલેટથી ચૂકવેલો ઓર્ડર રદ થાય, તો પૈસા તરત તમારા વૉલેટમાં પાછા આવે છે.\n- વૉલેટથી ચૂકવેલી ડિલિવરી ચૂકી જાય, તો અમે દરેક કિસ્સો જોઈને પૈસા તમારા વૉલેટમાં પાછા આપીએ છીએ.\n- વૉલેટ સ્ક્રીન પરથી તમે આખું વૉલેટ બેલેન્સ પાછું માંગી શકો. તે જે PhonePe ચુકવણીથી ઉમેર્યું હતું ત્યાં પાછું જાય છે અને સામાન્ય રીતે 7–10 કામકાજના દિવસમાં મળે છે.\n- એક સમયે એક જ રિફંડ વિનંતી ચાલુ રહી શકે. તે રસ્તામાં હોય ત્યાં સુધી એ પૈસા વાપરી શકાતા નથી.')
    ) AS t(type, wallet_en, wallet_gu)
  LOOP
    SELECT * INTO current_row FROM policy_documents WHERE type = section.type AND status = 'published';
    -- No published version, or the wallet wording is already there: nothing to do for this policy.
    CONTINUE WHEN NOT FOUND OR position('Wallet' IN current_row.body_en) > 0;

    -- 1.0 -> 1.1, 1.1 -> 1.2. A version label that is not like "1.0" stops everything (nothing is changed).
    new_version := split_part(current_row.version, '.', 1) || '.' || (coalesce(nullif(split_part(current_row.version, '.', 2), ''), '0')::int + 1);

    UPDATE policy_documents SET status = 'archived', updated_at = now() WHERE id = current_row.id;

    INSERT INTO policy_documents (type, version, title_en, title_gu, body_en, body_gu, effective_date, status, published_at)
    VALUES (
      section.type, new_version, current_row.title_en, current_row.title_gu,
      -- The wallet section goes just before the last paragraph (found as the last blank line); with no blank line, at the end.
      pg_temp.wallet_inserted(current_row.body_en, section.wallet_en),
      CASE WHEN current_row.body_gu = '' THEN '' ELSE pg_temp.wallet_inserted(current_row.body_gu, section.wallet_gu) END,
      (now() AT TIME ZONE 'Asia/Kolkata')::date, 'published', now()
    );
  END LOOP;
END $$;

COMMIT;
