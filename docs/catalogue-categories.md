# Catalogue categories

The catalogue is no longer only mobile phones. Every item belongs to a **category**, so devices and other services can be offered side by side, grouped and filtered.

## What ships

Seven categories are created by `migrations/010_catalogue_categories.sql` (run it once; it is safe to re-run):

| Category | Items need a model and manufacturer? |
|---|---|
| Mobile Phones | yes |
| Tablets | yes |
| Laptops & Computers | yes |
| Routers & MiFi | yes |
| Data & Connectivity (SIM cards, data bundles) | no |
| Accessories | yes |
| Other Services | no |

Every existing item becomes a **Mobile Phone**. An item inserted with no category (the sample-device script, manual SQL, an older backend) also lands in Mobile Phones. `Sample Device Insert script` now assigns tablets and routers to their own categories.

## What Admins can do (Catalogue → Manage categories)

* **Add** a category, **rename** it, give it a description and an order.
* Decide whether its items **need a model and manufacturer** (phones, laptops) or **not** (a data bundle, a service).
* **Switch it off**: the category and all its items disappear from the client catalogue and cannot be applied for, without deleting anything. Applications already made are unaffected.
* **Delete** it, but only when it holds no items (switch it off instead). Changes are recorded in the Audit Log (`CATEGORY_CREATED`, `CATEGORY_UPDATED`, `CATEGORY_DELETED`).

Adding an item: pick the category first; the form then asks for model and manufacturer only where the category needs them. An item can be moved to another category; moving it into one that needs a model and manufacturer is refused if it has none.

## What clients see

The Catalogue page shows a chip per category that has something on offer (with counts, in the Admin's order), search that also matches the category name, and an icon and label on each card. With only one category on offer there are no chips.

## API

| | |
|---|---|
| `GET /api/device-categories` | Active categories with `total_items` / `active_items`. Any signed-in user |
| `GET /api/device-categories?include_inactive=true` | Also switched-off ones. Admin only |
| `POST /api/device-categories` | `{ name, description?, requires_hardware_details?, sort_order? }`. Admin |
| `PUT /api/device-categories/:id` | Any of those fields, plus `is_active`. Admin |
| `DELETE /api/device-categories/:id` | Only if empty (409 otherwise). Admin |
| `GET /api/devices?category_id=…` | Filter the catalogue; every item carries `category_id` and `category_name` |
| `POST/PUT /api/devices` | Accept `category_id` |

The statistics endpoint adds `by_category`, and the Inventory report adds a Category column.

## Things to know

* **Contract length is required.** The database has never allowed an item without one. The form no longer offers "No contract", and the API says so plainly instead of failing on insert.
* **Everything is still an application with a monthly cost and a contract length.** A once-off purchase or an item with no monthly cost does not fit yet; say if you need that.
* **Stock** works as before (blank means unlimited), so services need no stock figure.
