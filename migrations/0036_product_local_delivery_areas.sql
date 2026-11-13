BEGIN;

CREATE TABLE IF NOT EXISTS product_local_delivery_areas (
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  service_area_id uuid NOT NULL REFERENCES service_areas (id),
  PRIMARY KEY (product_id, service_area_id)
);

CREATE INDEX IF NOT EXISTS product_local_delivery_areas_area_idx
  ON product_local_delivery_areas (service_area_id);

GRANT SELECT, INSERT, DELETE ON product_local_delivery_areas TO shreeram_app;

COMMIT;
