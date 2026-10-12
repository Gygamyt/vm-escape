CXX      ?= g++
CXXFLAGS ?= -std=c++17 -O2 -Wall
LDFLAGS  ?= -lz
TARGET    = vm_encoder
SRC       = vm_encoder.cpp

all: $(TARGET)

$(TARGET): $(SRC)
	$(CXX) $(CXXFLAGS) -o $@ $< $(LDFLAGS)

clean:
	rm -f $(TARGET)

.PHONY: all clean
