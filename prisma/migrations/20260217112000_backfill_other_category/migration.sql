INSERT INTO "categories" ("id", "userId", "name", "isDefault", "createdAt")
SELECT gen_random_uuid(), u.id, '📦Другое', true, NOW()
FROM "users" u
WHERE NOT EXISTS (
  SELECT 1
  FROM "categories" c
  WHERE c."userId" = u.id
    AND c."name" = '📦Другое'
);
