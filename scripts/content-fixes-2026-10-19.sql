-- One-time content clean-up before launch (19 Oct 2026): replaces test and placeholder text left in the admin.
-- Run ONCE in pgAdmin on the live database, as the migration user (shreeram_migrate). Safe to run again: each change only
-- touches rows that still hold the old text. Everything runs in one transaction, so it either all applies or nothing does.
-- Afterwards everything here can still be edited normally in the admin panel.

BEGIN;

-- 1. App Settings: the real support contact (the developer's email was still set) and wording without a delivery-time promise.
UPDATE app_settings SET
  support_email          = 'shreerammilks4244@gmail.com',
  support_phone          = '+917984799395',
  support_whatsapp       = '+917984799395',
  call_enabled           = true,
  support_hours_en       = 'Every day',
  support_hours_gu       = 'દરરોજ',
  after_hours_message_en = 'We are closed right now. Leave a message on WhatsApp and we will reply when we open.',
  after_hours_message_gu = 'અત્યારે અમારી સેવા બંધ છે. વોટ્સએપ પર સંદેશ મૂકો, ખુલતાં જ જવાબ આપીશું.',
  delivery_promise_en    = 'Delivered every morning',
  delivery_promise_gu    = 'દરરોજ સવારે ડિલિવરી',
  maintenance_message_en = 'We are updating the app. Please try again in a little while.',
  maintenance_message_gu = 'અમે એપ અપડેટ કરી રહ્યા છીએ. થોડી વાર પછી ફરી પ્રયાસ કરો.',
  updated_at             = now()
WHERE id;

-- 2. Onboarding: fix the "Welocme" typo and remove the "before 7 AM" promise.
UPDATE onboarding_slides SET
  title_en       = 'Welcome to ShreeRam Milks',
  description_en = 'Fresh milk and dairy from our Gandhinagar dairy, delivered to your doorstep every morning.',
  description_gu = 'અમારી ગાંધીનગરની ડેરીમાંથી તાજું દૂધ અને ડેરી ઉત્પાદનો, દરરોજ સવારે તમારા ઘરે.',
  updated_at     = now()
WHERE title_en = 'Welocme to ShreeRam Milks' OR description_en ILIKE '%before 7 AM%';

-- 3. Help Center: hide the test question and publish real ones.
UPDATE faqs SET status = 'inactive', featured = false, updated_at = now()
WHERE question_en ILIKE 'thisis test%';

INSERT INTO faqs (topic_id, question_en, question_gu, answer_en, answer_gu, search_keywords, featured, sort_order, status)
SELECT v.topic_id, v.q_en, v.q_gu, v.a_en, v.a_gu, v.keywords, false, v.sort_order, 'published'
FROM (VALUES
  ('delivery_missing', 'My delivery did not arrive. What should I do?', 'મારી ડિલિવરી આવી નથી. હું શું કરું?',
   'Our delivery person calls you first. If we could not reach you, we took the order back. Contact us from Support and choose a refund or delivery on the next day.',
   'અમારો ડિલિવરી કરનાર પહેલાં તમને ફોન કરે છે. સંપર્ક ન થયો હોય તો ઓર્ડર પાછો લઈ જવાયો છે. સપોર્ટ દ્વારા અમારો સંપર્ક કરો અને રિફંડ કે બીજા દિવસે ડિલિવરી પસંદ કરો.',
   ARRAY['missed', 'not received', 'no milk'], 1),
  ('late_delivery', 'Until when can I change or cancel tomorrow''s delivery?', 'આવતીકાલની ડિલિવરી ક્યાં સુધી બદલી કે રદ કરી શકું?',
   'Every delivery time slot has an order-by time, shown in the app. Before it you can cancel, skip or change the delivery. After it, that day is final.',
   'દરેક ડિલિવરી સમયનો ઓર્ડરનો છેલ્લો સમય એપમાં બતાવેલો છે. તે પહેલાં તમે ડિલિવરી રદ કરી, છોડી કે બદલી શકો છો. તે પછી એ દિવસ નક્કી થઈ જાય છે.',
   ARRAY['cutoff', 'order by', 'change'], 1),
  ('quality_issue', 'The milk was spoiled. What can I do?', 'દૂધ બગડેલું હતું. હું શું કરું?',
   'Tell us the same day, within 12 hours of delivery, from Support or Report an issue, with a photo if you can. We will replace it or refund it, as you prefer.',
   'તે જ દિવસે, ડિલિવરીના 12 કલાકમાં, સપોર્ટ કે ફરિયાદ નોંધાવો દ્વારા જણાવો, શક્ય હોય તો ફોટા સાથે. તમારી પસંદ મુજબ અમે બદલી આપીશું કે રિફંડ આપીશું.',
   ARRAY['spoiled', 'sour', 'bad milk', 'leak'], 1),
  ('payment_issue', 'When will I get my refund?', 'મને રિફંડ ક્યારે મળશે?',
   'Refunds are started within 5 to 7 working days, by UPI or to the original PhonePe payment method. For credit customers the amount is taken off what you owe.',
   'રિફંડ 5 થી 7 કામકાજના દિવસમાં UPI દ્વારા અથવા મૂળ PhonePe ચુકવણી પદ્ધતિમાં શરૂ થાય છે. ક્રેડિટ ગ્રાહકો માટે રકમ બાકી રકમમાંથી બાદ થાય છે.',
   ARRAY['refund', 'money back'], 1),
  ('subscription_issue', 'How do I pause my plan when I travel?', 'બહાર જાઉં ત્યારે પ્લાન કેવી રીતે થોભાવું?',
   'Open Plans, choose your plan and tap Going away. Pick the days you are away and the day to restart. The paused days are added at the end of your plan.',
   'પ્લાન ખોલો, તમારો પ્લાન પસંદ કરો અને "બહાર જાઉં છું" દબાવો. તમે બહાર હો તે દિવસો અને ફરી શરૂ કરવાનો દિવસ પસંદ કરો. થોભાવેલા દિવસો પ્લાનના અંતે ઉમેરાય છે.',
   ARRAY['vacation', 'pause', 'travel'], 1),
  ('subscription_issue', 'What happens when I skip a day?', 'દિવસ છોડું તો શું થાય?',
   'A skipped day is added at the end of your plan, so you do not lose it. A skip you make yourself cannot be undone in the app; contact us if you skipped by mistake.',
   'છોડેલો દિવસ તમારા પ્લાનના અંતે ઉમેરાય છે, તેથી તે જતો નથી. તમે જાતે છોડેલો દિવસ એપમાં પાછો લાવી શકાતો નથી; ભૂલથી છોડ્યો હોય તો અમારો સંપર્ક કરો.',
   ARRAY['skip'], 2),
  ('address_issue', 'Do you deliver to my area?', 'શું તમે મારા વિસ્તારમાં ડિલિવરી કરો છો?',
   'Fresh milk is delivered by our own team in Gandhinagar. Other products can be sent anywhere in India by courier. Enter your PIN code in the app to see what we deliver to you.',
   'તાજું દૂધ અમારી ટીમ ગાંધીનગરમાં પહોંચાડે છે. બીજા ઉત્પાદનો કુરિયર દ્વારા આખા ભારતમાં મોકલી શકાય છે. તમને શું પહોંચે છે તે જોવા એપમાં તમારો પિન કોડ નાખો.',
   ARRAY['area', 'pin code', 'courier'], 1)
) AS v(topic_id, q_en, q_gu, a_en, a_gu, keywords, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM faqs f WHERE f.question_en = v.q_en);

-- 4. Products: hide the test product, unless a customer still has a running plan for it (then switch it off in the admin later).
UPDATE products SET status = 'inactive', updated_at = now()
WHERE name = 'test produt one'
  AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.product_id = products.id AND s.status = 'active');

-- 5. Categories: remove the placeholder description.
UPDATE categories SET description = '', updated_at = now() WHERE description = 'this is first catgeory';

-- 6. Banners: the Gujarati title was left in English.
UPDATE banners SET title_gu = 'દરરોજ તાજગી, તમારા ઘરે', updated_at = now()
WHERE title_en = 'Freshness Delivered Daily' AND title_gu = 'Freshness Delivered Daily';

-- 7. Website Home page: remove the "before 7 AM" promise.
UPDATE website_home SET
  content = jsonb_set(jsonb_set(jsonb_set(jsonb_set(content,
    '{heroSubtitle}', to_jsonb('Fresh milk, curd, paneer and ghee from our own dairy in Gandhinagar. Order once, try a trial, or subscribe and pause any time.'::text)),
    '{highlights,1}', '{"title": "Delivered every morning", "text": "On your doorstep in the time slot you choose."}'::jsonb),
    '{seoDescription}', to_jsonb('Order fresh milk, curd, paneer and ghee online from ShreeRam Milks, Gandhinagar. Daily delivery, trials and subscriptions you can pause any time.'::text)),
    '{highlights,0,text}', to_jsonb('Collected, checked and delivered fresh every day.'::text)),
  updated_at = now()
WHERE content->>'heroSubtitle' ILIKE '%before 7 AM%';

COMMIT;

-- Quick check after running (each should return the new text):
-- SELECT support_email, support_phone, delivery_promise_en FROM app_settings;
-- SELECT title_en, description_en FROM onboarding_slides ORDER BY sort_order;
-- SELECT question_en, status FROM faqs ORDER BY topic_id, sort_order;
-- SELECT name, status FROM products;
-- SELECT content->>'heroSubtitle' FROM website_home;
