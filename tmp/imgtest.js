var fs = require('fs'),
    PNG = require('pngjs').PNG;
var bitmap = [];

for (var i = 0; i < 960; i++) {
    bitmap.push([]);
}

fs.createReadStream('map.png')
    .pipe(new PNG({
        filterType: 4
    }))
    .on('parsed', function() {

        for (var y = 0; y < this.height; y++) {
            for (var x = 0; x < this.width; x++) {
                var idx = (this.width * y + x) << 2;
                bitmap[x][y] = this.data[idx+3] ? 1 :0;
            }
        }

        console.log(bitmap[480][530]);
    });
