-- Starting city tiers for ranking bids by closeness to Orlando. Edit them in Admin; these never overwrite a city you already set.
-- Tier 1 Central Florida (Ocala to Sarasota, with Orlando), Tier 2 Tampa and Southwest Florida, Tier 3 Miami and South Florida, Tier 4 Jacksonville, Northeast Florida and the Panhandle.
INSERT INTO region_tiers(city, tier) VALUES
 ('Orlando',1),('Winter Park',1),('Winter Garden',1),('Windermere',1),('Ocoee',1),('Apopka',1),('Maitland',1),('Altamonte Springs',1),('Casselberry',1),('Longwood',1),('Lake Mary',1),('Sanford',1),('Oviedo',1),('Winter Springs',1),
 ('Kissimmee',1),('St Cloud',1),('Saint Cloud',1),('Davenport',1),('Haines City',1),('Clermont',1),('Minneola',1),('Groveland',1),('Mount Dora',1),('Eustis',1),('Tavares',1),('Leesburg',1),('Lady Lake',1),('The Villages',1),('Ocala',1),
 ('Lakeland',1),('Winter Haven',1),('Bartow',1),('Auburndale',1),('Deltona',1),('DeLand',1),('Sarasota',1),('Bradenton',1),('Lakewood Ranch',1),('Venice',1),('North Port',1),
 ('Tampa',2),('St Petersburg',2),('Saint Petersburg',2),('Clearwater',2),('Largo',2),('Brandon',2),('Riverview',2),('Plant City',2),('Wesley Chapel',2),('Land O Lakes',2),('Lutz',2),('Spring Hill',2),('Brooksville',2),('New Port Richey',2),('Dunedin',2),
 ('Fort Myers',2),('Cape Coral',2),('Bonita Springs',2),('Estero',2),('Naples',2),('Punta Gorda',2),('Port Charlotte',2),('Lehigh Acres',2),
 ('Daytona Beach',2),('Port Orange',2),('Ormond Beach',2),('New Smyrna Beach',2),('Titusville',2),('Cocoa',2),('Cocoa Beach',2),('Melbourne',2),('Palm Bay',2),('Rockledge',2),('Viera',2),('Vero Beach',2),('Sebastian',2),
 ('Miami',3),('Miami Beach',3),('Doral',3),('Hialeah',3),('Homestead',3),('Coral Gables',3),('Kendall',3),('Aventura',3),('North Miami',3),('Fort Lauderdale',3),('Hollywood',3),('Pembroke Pines',3),('Miramar',3),('Davie',3),('Plantation',3),('Sunrise',3),('Coral Springs',3),('Pompano Beach',3),('Deerfield Beach',3),
 ('Boca Raton',3),('Delray Beach',3),('Boynton Beach',3),('West Palm Beach',3),('Palm Beach Gardens',3),('Jupiter',3),('Wellington',3),('Stuart',3),('Port St Lucie',3),('Fort Pierce',3),('Key West',3),('Marathon',3),
 ('Jacksonville',4),('Jacksonville Beach',4),('Orange Park',4),('St Augustine',4),('Palm Coast',4),('Fernandina Beach',4),('Lake City',4),('Gainesville',4),('Tallahassee',4),('Panama City',4),('Panama City Beach',4),('Destin',4),('Fort Walton Beach',4),('Pensacola',4),('Niceville',4),('Crestview',4)
ON CONFLICT (city) DO NOTHING;
